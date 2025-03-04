import {
  BuildManifest,
  clientWebsocketMessages,
  CreateBackgroundWorkerRequestBody,
  SemanticInternalAttributes,
  serverWebsocketMessages,
  TaskManifest,
  TaskRunExecutionLazyAttemptPayload,
  TaskRunExecutionMetrics,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import {
  MessagePayloadFromSchema,
  ZodMessageHandler,
  ZodMessageSender,
} from "@trigger.dev/core/v3/zodMessageHandler";
import { ClientRequestArgs } from "node:http";
import { WebSocket } from "partysocket";
import { ClientOptions, WebSocket as wsWebSocket } from "ws";
import { CliApiClient } from "../apiClient.js";
import { DevCommandOptions } from "../commands/dev.js";
import { chalkError, chalkTask, cliLink, prettyError } from "../utilities/cliOutput.js";
import { resolveDotEnvVars } from "../utilities/dotEnv.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { BackgroundWorker, BackgroundWorkerCoordinator } from "./backgroundWorker.js";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";
import { VERSION } from "../version.js";

export interface WorkerRuntime {
  shutdown(): Promise<void>;
  initializeWorker(manifest: BuildManifest, stop: () => void): Promise<void>;
}

export type WorkerRuntimeOptions = {
  name: string | undefined;
  config: ResolvedConfig;
  args: DevCommandOptions;
  client: CliApiClient;
  dashboardUrl: string;
};

export async function startWorkerRuntime(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const runtime = new DevWorkerRuntime(options);

  await runtime.init();

  return runtime;
}

class DevWorkerRuntime implements WorkerRuntime {
  private websocket: WebSocket;
  private backgroundWorkerCoordinator: BackgroundWorkerCoordinator;
  private sender: ZodMessageSender<typeof clientWebsocketMessages>;
  private websocketMessageHandler: ZodMessageHandler<typeof serverWebsocketMessages>;
  private lastBuild: BuildManifest | undefined;

  constructor(public readonly options: WorkerRuntimeOptions) {
    const websocketUrl = new URL(this.options.client.apiURL);
    websocketUrl.protocol = websocketUrl.protocol.replace("http", "ws");
    websocketUrl.pathname = `/ws`;

    this.sender = new ZodMessageSender({
      schema: clientWebsocketMessages,
      sender: async (message) => {
        this.websocket.send(JSON.stringify(message));
      },
    });

    this.backgroundWorkerCoordinator = new BackgroundWorkerCoordinator();

    this.backgroundWorkerCoordinator.onWorkerTaskRunHeartbeat.attach(
      async ({ worker, backgroundWorkerId, id }) => {
        await this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_HEARTBEAT",
            id,
          },
        });
      }
    );

    this.backgroundWorkerCoordinator.onTaskCompleted.attach(
      async ({ backgroundWorkerId, completion, execution }) => {
        await this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_COMPLETED",
            completion,
            execution,
          },
        });
      }
    );

    this.backgroundWorkerCoordinator.onTaskFailedToRun.attach(
      async ({ backgroundWorkerId, completion }) => {
        await this.sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId,
          data: {
            type: "TASK_RUN_FAILED_TO_RUN",
            completion,
          },
        });
      }
    );

    this.backgroundWorkerCoordinator.onWorkerRegistered.attach(async ({ id, worker, record }) => {
      await this.sender.send("READY_FOR_TASKS", {
        backgroundWorkerId: id,
      });
    });

    this.websocketMessageHandler = new ZodMessageHandler({
      schema: serverWebsocketMessages,
      messages: {
        SERVER_READY: async (payload) => {
          await this.#serverReady(payload);
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          await this.#backgroundWorkerMessage(payload);
        },
      },
    });

    this.websocket = new WebSocket(websocketUrl.href, [], {
      WebSocket: WebsocketFactory(this.options.client.accessToken!),
      connectionTimeout: 10000,
      maxRetries: 64,
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 5000,
      reconnectionDelayGrowFactor: 1.4,
      maxEnqueuedMessages: 1250,
    });

    this.websocket.addEventListener("open", async (event) => {
      logger.debug("WebSocket opened", { event });
    });

    this.websocket.addEventListener("close", (event) => {
      logger.debug("WebSocket closed", { event });
    });

    this.websocket.addEventListener("error", (event) => {
      logger.debug(`${chalkError("WebSocketError:")} ${event.error.message}`);
    });

    this.websocket.addEventListener("message", this.#handleWebsocketMessage.bind(this));
  }

  async init(): Promise<void> {
    logger.debug("initialized worker runtime", { options: this.options });
  }

  async shutdown(): Promise<void> {
    try {
      if (
        this.websocket.readyState === WebSocket.OPEN ||
        this.websocket.readyState === WebSocket.CONNECTING
      ) {
        this.websocket.close();
      }
    } catch (error) {
      logger.debug("Error while shutting down worker runtime", { error });
    }
  }

  async initializeWorker(manifest: BuildManifest, stop: () => void): Promise<void> {
    if (this.lastBuild && this.lastBuild.contentHash === manifest.contentHash) {
      eventBus.emit("workerSkipped");
      stop();
      return;
    }

    const env = await this.#getEnvVars();

    const backgroundWorker = new BackgroundWorker(manifest, {
      env,
      cwd: this.options.config.workingDir,
      stop,
    });

    await backgroundWorker.initialize();

    if (!backgroundWorker.manifest) {
      stop();
      throw new Error("Could not initialize worker");
    }

    const validationIssue = validateWorkerManifest(backgroundWorker.manifest);

    if (validationIssue) {
      prettyError(
        generationValidationIssueHeader(validationIssue),
        generateValidationIssueMessage(validationIssue, backgroundWorker.manifest!, manifest),
        generateValidationIssueFooter(validationIssue)
      );

      stop();
      return;
    }

    const sourceFiles = resolveSourceFiles(manifest.sources, backgroundWorker.manifest.tasks);

    const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
      localOnly: true,
      metadata: {
        packageVersion: manifest.packageVersion,
        cliPackageVersion: manifest.cliPackageVersion,
        tasks: backgroundWorker.manifest.tasks,
        contentHash: manifest.contentHash,
        sourceFiles,
      },
      supportsLazyAttempts: true,
    };

    const backgroundWorkerRecord = await this.options.client.createBackgroundWorker(
      this.options.config.project,
      backgroundWorkerBody
    );

    if (!backgroundWorkerRecord.success) {
      stop();
      throw new Error(backgroundWorkerRecord.error);
    }

    backgroundWorker.serverWorker = backgroundWorkerRecord.data;
    this.backgroundWorkerCoordinator.registerWorker(backgroundWorker);
    this.lastBuild = manifest;

    eventBus.emit("backgroundWorkerInitialized", backgroundWorker);
  }

  async #getEnvVars(): Promise<Record<string, string>> {
    const environmentVariablesResponse = await this.options.client.getEnvironmentVariables(
      this.options.config.project
    );

    const processEnv = gatherProcessEnv();
    const dotEnvVars = resolveDotEnvVars(undefined, this.options.args.envFile);
    const OTEL_IMPORT_HOOK_INCLUDES = (this.options.config.instrumentedPackageNames ?? []).join(
      ","
    );

    return {
      ...sanitizeEnvVars(processEnv),
      ...sanitizeEnvVars(
        environmentVariablesResponse.success ? environmentVariablesResponse.data.variables : {}
      ),
      ...sanitizeEnvVars(dotEnvVars),
      TRIGGER_API_URL: this.options.client.apiURL,
      TRIGGER_SECRET_KEY: this.options.client.accessToken!,
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
        [SemanticInternalAttributes.PROJECT_DIR]: this.options.config.workingDir,
      }),
      OTEL_IMPORT_HOOK_INCLUDES,
    };
  }

  async #handleWebsocketMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      await this.websocketMessageHandler.handleMessage(data);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("Error while handling websocket message", { error: error.message });
      } else {
        logger.error(
          "Unkown error while handling websocket message, use `-l debug` for additional output"
        );
        logger.debug("Error while handling websocket message", { error });
      }
    }
  }

  async #serverReady(
    payload: MessagePayloadFromSchema<"SERVER_READY", typeof serverWebsocketMessages>
  ) {
    for (const worker of this.backgroundWorkerCoordinator.currentWorkers) {
      await this.sender.send("READY_FOR_TASKS", {
        backgroundWorkerId: worker.id,
        inProgressRuns: worker.worker.inProgressRuns,
      });
    }
  }

  async #backgroundWorkerMessage(
    payload: MessagePayloadFromSchema<"BACKGROUND_WORKER_MESSAGE", typeof serverWebsocketMessages>
  ) {
    const message = payload.data;

    logger.debug(
      `Received message from worker ${payload.backgroundWorkerId}`,
      JSON.stringify({ workerMessage: message })
    );

    switch (message.type) {
      case "CANCEL_ATTEMPT": {
        // Need to cancel the attempt somehow here
        this.backgroundWorkerCoordinator.cancelRun(payload.backgroundWorkerId, message.taskRunId);
        break;
      }
      case "EXECUTE_RUN_LAZY_ATTEMPT": {
        await this.#executeTaskRunLazyAttempt(payload.backgroundWorkerId, message.payload);
      }
    }
  }

  async #executeTaskRunLazyAttempt(id: string, payload: TaskRunExecutionLazyAttemptPayload) {
    const createAttemptStart = Date.now();

    const attemptResponse = await this.options.client.createTaskRunAttempt(payload.runId);

    if (!attemptResponse.success) {
      throw new Error(`Failed to create task run attempt: ${attemptResponse.error}`);
    }

    const execution = attemptResponse.data;

    logger.debug("Executing task run lazy attempt", { execution });

    const completion = await this.backgroundWorkerCoordinator.executeTaskRun(
      id,
      {
        execution,
        traceContext: payload.traceContext,
        environment: payload.environment,
        metrics: [
          {
            name: "start",
            event: "create_attempt",
            timestamp: createAttemptStart,
            duration: Date.now() - createAttemptStart,
          },
        ].concat(payload.metrics ?? []),
      },
      payload.messageId
    );

    return { execution, completion };
  }
}

function WebsocketFactory(apiKey: string) {
  return class extends wsWebSocket {
    constructor(address: string | URL, options?: ClientOptions | ClientRequestArgs) {
      super(address, {
        ...(options ?? {}),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": `trigger.dev-cli/${VERSION}`,
        },
      });
    }
  };
}

function gatherProcessEnv() {
  const $env = {
    ...process.env,
    NODE_ENV: "development",
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries($env).filter(([key, value]) => value !== undefined));
}

type ValidationIssue =
  | {
      type: "duplicateTaskId";
      duplicationTaskIds: string[];
    }
  | {
      type: "noTasksDefined";
    };

function validateWorkerManifest(manifest: WorkerManifest): ValidationIssue | undefined {
  const issues: ValidationIssue[] = [];

  if (!manifest.tasks || manifest.tasks.length === 0) {
    return { type: "noTasksDefined" };
  }

  // Check for any duplicate task ids
  const taskIds = manifest.tasks.map((task) => task.id);
  const duplicateTaskIds = taskIds.filter((id, index) => taskIds.indexOf(id) !== index);

  if (duplicateTaskIds.length > 0) {
    return { type: "duplicateTaskId", duplicationTaskIds: duplicateTaskIds };
  }

  return undefined;
}

function generationValidationIssueHeader(issue: ValidationIssue) {
  switch (issue.type) {
    case "duplicateTaskId": {
      return `Duplicate task ids detected`;
    }
    case "noTasksDefined": {
      return `No tasks exported from your trigger files`;
    }
  }
}

function generateValidationIssueFooter(issue: ValidationIssue) {
  switch (issue.type) {
    case "duplicateTaskId": {
      return cliLink("View the task docs", "https://trigger.dev/docs/tasks/overview");
    }
    case "noTasksDefined": {
      return cliLink("View the task docs", "https://trigger.dev/docs/tasks/overview");
    }
  }
}

function generateValidationIssueMessage(
  issue: ValidationIssue,
  manifest: WorkerManifest,
  buildManifest: BuildManifest
) {
  switch (issue.type) {
    case "duplicateTaskId": {
      return createDuplicateTaskIdOutputErrorMessage(issue.duplicationTaskIds, manifest.tasks);
    }
    case "noTasksDefined": {
      return `        
        Files:
        ${buildManifest.files.map((file) => file.entry).join("\n")}

        Make sure you have at least one task exported from your trigger files.

        You may have defined a task and forgot to add the export statement:

        \`\`\`ts
        import { task } from "@trigger.dev/sdk/v3";

        👇 Don't forget this
        export const myTask = task({
          id: "myTask",
          async run() {
            // Your task logic here
          }
        });
        \`\`\`
      `.replace(/^ {8}/gm, "");
    }
    default: {
      return `Unknown validation issue: ${issue}`;
    }
  }
}

function createDuplicateTaskIdOutputErrorMessage(
  duplicateTaskIds: Array<string>,
  tasks: Array<TaskManifest>
) {
  const duplicateTable = duplicateTaskIds
    .map((id) => {
      const $tasks = tasks.filter((task) => task.id === id);

      return `\n\n${chalkTask(id)} was found in:${tasks
        .map((task) => `\n${task.filePath} -> ${task.exportName}`)
        .join("")}`;
    })
    .join("");

  return `Duplicate ${chalkTask("task id")} detected:${duplicateTable}`;
}
