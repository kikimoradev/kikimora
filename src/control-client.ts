import { connect } from "node:net";
import type { ControlRequestInput, ControlResponse } from "./control-protocol.js";

const REQUEST_TIMEOUT_MS = 5_000;

export class WorkerNotRunningError extends Error {
  constructor() {
    super("No kikimora worker is running in this project.");
    this.name = "WorkerNotRunningError";
  }
}

export class ControlSocketAccessError extends Error {
  constructor(socketPath: string) {
    super(
      `Permission denied on the control socket ${socketPath} — it belongs to the user running the worker.`,
    );
    this.name = "ControlSocketAccessError";
  }
}

function isAccessDenied(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "EACCES";
}

export interface ControlRequestOptions {
  timeoutMs?: number | undefined;
}

export function sendControlRequest<R extends ControlRequestInput>(
  socketPath: string,
  request: R,
  options: ControlRequestOptions = {},
): Promise<ControlResponse<R["cmd"]>> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const succeed = (response: ControlResponse<R["cmd"]>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(response);
    };
    socket.setTimeout(timeoutMs, () => {
      fail(new Error("Timed out waiting for the worker to respond."));
    });
    socket.on("error", (error) => {
      fail(
        isAccessDenied(error)
          ? new ControlSocketAccessError(socketPath)
          : new WorkerNotRunningError(),
      );
    });
    socket.on("close", () => {
      fail(new WorkerNotRunningError());
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        succeed(JSON.parse(buffer.slice(0, newline)) as ControlResponse<R["cmd"]>);
      } catch {
        fail(new Error("Received a malformed response from the worker."));
      }
    });
  });
}
