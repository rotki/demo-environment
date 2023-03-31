import fs from "node:fs";
import * as querystring from "node:querystring";
import assert from "node:assert";
import { json, urlencoded } from "body-parser";
import express, { type Request, type Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createLogger, format, transports } from "winston";
import { enableCors } from "./setup";
import { healthcheck } from "./api/healthcheck";
import type * as http from "node:http";

const logger = createLogger({
  transports: [new transports.Console()],
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf(
      ({ timestamp, level, message, service }) =>
        `[${timestamp}] ${service} ${level}: ${message}`
    )
  ),
  defaultMeta: {
    service: "Demo",
  },
});

const target = process.env["ROTKI_URL"];
const port = process.env["PORT"] || 443;

if (!target) {
  logger.error("Missing ROTKI_URL environment variable");
  process.exit(1);
}

const server = express();
enableCors(server);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockedAsyncCalls: { [url: string]: any } = {};
if (fs.existsSync("async-mock.json")) {
  try {
    logger.info("Loading mock data from async-mock.json");
    const buffer = fs.readFileSync("async-mock.json");
    mockedAsyncCalls = JSON.parse(buffer.toString());
  } catch (e) {
    logger.error(e);
  }
} else {
  logger.info(
    "async-mock.json doesnt exist. No async_query mocking is enabled"
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manipulateResponse = (
  res: Response,
  callback: (original: any) => any
) => {
  const originalWrite = res.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = (chunk: any) => {
    const response = chunk.toString();
    try {
      const payload = JSON.stringify(callback(JSON.parse(response)));
      res.header("content-length", payload.length.toString());
      res.status(200);
      res.statusMessage = "OK";
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      originalWrite.call(res, payload);
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      logger.error(e);
      return false;
    }
  };
};

let mockTaskId = 100000;
const mockAsync: {
  pending: number[];
  completed: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  taskResponses: { [task: number]: any };
} = {
  pending: [],
  completed: [],
  taskResponses: {},
};

const counter: { [url: string]: { [method: string]: number } } = {};

setInterval(() => {
  const pending = mockAsync.pending;
  const completed = mockAsync.completed;
  if (pending.length > 0) {
    logger.debug(`detected ${pending.length} pending tasks: ${pending}`);
  }

  while (pending.length > 0) {
    const task = pending.pop();
    if (task) {
      completed.push(task);
    }
  }

  if (completed.length > 0) {
    logger.debug(`detected ${completed.length} completed tasks: ${completed}`);
  }
}, 8000);

const createResult = (result: unknown): Record<string, unknown> => ({
  result,
  message: "",
});

const handleTasksStatus = (res: Response): void => {
  manipulateResponse(res, (data) => {
    const result = data.result;
    if (result && result.pending) {
      result.pending.push(...mockAsync.pending);
    } else {
      result.pending = mockAsync.pending;
    }

    if (result && result.completed) {
      result.completed.push(...mockAsync.completed);
    } else {
      result.completed = mockAsync.completed;
    }

    return data;
  });
};

const handleTaskRequest = (url: string, tasks: string, res: Response): void => {
  const task = url.replace(tasks, "");
  try {
    const taskId = Number.parseInt(task);
    if (Number.isNaN(taskId)) {
      return;
    }
    if (mockAsync.completed.includes(taskId)) {
      const outcome = mockAsync.taskResponses[taskId];
      manipulateResponse(res, () =>
        createResult({
          outcome,
          status: "completed",
        })
      );
      delete mockAsync.taskResponses[taskId];
      const index = mockAsync.completed.indexOf(taskId);
      mockAsync.completed.splice(index, 1);
    } else if (mockAsync.pending.includes(taskId)) {
      manipulateResponse(res, () =>
        createResult({
          outcome: null,
          status: "pending",
        })
      );
    }
  } catch (e) {
    logger.error(e);
  }
};

const increaseCounter = (baseUrl: string, method: string): void => {
  if (!counter[baseUrl]) {
    counter[baseUrl] = {};
  }
  const urlCounter = counter[baseUrl];
  assert(urlCounter);
  if (urlCounter[method]) {
    urlCounter[method] += 1;
  } else {
    urlCounter[method] = 1;
  }
};

const getCounter = (baseUrl: string, method: string): number =>
  counter[baseUrl]?.[method] ?? 0;

const handleAsyncQuery = (url: string, req: Request, res: Response): void => {
  const mockedUrls = Object.keys(mockedAsyncCalls);
  const baseUrl = url.split("?")[0];
  assert(baseUrl);
  const index = mockedUrls.findIndex((value) => value.includes(baseUrl));

  if (index < 0) {
    return;
  }
  increaseCounter(baseUrl, req.method);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const response = mockedAsyncCalls[mockedUrls[index]]?.[req.method];
  if (!response) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pendingResponse: any;
  if (Array.isArray(response)) {
    const number = getCounter(baseUrl, req.method) - 1;
    if (number < response.length) {
      pendingResponse = response[number];
    } else {
      pendingResponse = response[response.length - 1];
    }
  } else if (typeof response === "object") {
    pendingResponse = response;
  } else {
    pendingResponse = {
      result: null,
      message: "There is something wrong with this mock",
    };
  }

  const taskId = mockTaskId++;
  mockAsync.pending.push(taskId);
  mockAsync.taskResponses[taskId] = pendingResponse;
  manipulateResponse(res, () => ({
    result: {
      task_id: taskId,
    },
    message: "",
  }));
};

const isAsyncQuery = (req: Request): boolean =>
  req.method !== "GET" &&
  req.rawHeaders.findIndex((h) =>
    h.toLocaleLowerCase().includes("application/json")
  ) &&
  req.body &&
  req.body.async_query === true;

const isPreflight = (req: Request): boolean => {
  const mockedUrls = Object.keys(mockedAsyncCalls);
  const baseUrl = req.url.split("?")[0];
  assert(baseUrl);
  const index = mockedUrls.findIndex((value) => value.includes(baseUrl));
  return req.method === "OPTIONS" && index >= 0;
};

const onProxyReq = (
  proxyReq: http.ClientRequest,
  req: Request,
  _res: Response
): void => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return;
  }

  const contentType = proxyReq.getHeader("Content-Type") ?? "";
  const writeBody = (bodyData: string) => {
    proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  };

  const ct = contentType.toString().toLocaleLowerCase();
  if (ct.startsWith("application/json")) {
    writeBody(JSON.stringify(req.body));
  }

  if (ct.startsWith("application/x-www-form-urlencoded")) {
    writeBody(querystring.stringify(req.body));
  }
};

const mockPreflight = (res: Response): void => {
  const originalWrite = res.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = (chunk: any) => {
    try {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Headers",
        "X-Requested-With,content-type"
      );
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS, PUT, PATCH, DELETE"
      );
      res.header("Access-Control-Allow-Credentials", "true");
      res.status(200);
      res.statusMessage = "OK";
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      originalWrite.call(res, chunk);
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch {
      return false;
    }
  };
};

const hasResponse = (req: Request): boolean => {
  const mockResponse = mockedAsyncCalls[req.url];
  return !!mockResponse && !!mockResponse[req.method];
};

const onProxyRes = (
  _msg: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  let handled = false;
  const url = req.url;
  const tasks = "/api/1/tasks/";
  if (url.indexOf("async_query") > 0) {
    handleAsyncQuery(url, req, res);
    handled = true;
  } else if (url === tasks) {
    handleTasksStatus(res);
    handled = true;
  } else if (url.startsWith(tasks)) {
    handleTaskRequest(url, tasks, res);
    handled = true;
  } else if (isAsyncQuery(req)) {
    handleAsyncQuery(url, req, res);
    handled = true;
  } else if (isPreflight(req)) {
    mockPreflight(res);
    handled = true;
  } else if (hasResponse(req)) {
    manipulateResponse(res, () => {
      const response = mockedAsyncCalls[req.url][req.method];
      if (Array.isArray(response)) {
        const index = getCounter(req.url, req.method);
        let responseIndex = index;
        if (index > response.length - 1) {
          responseIndex = response.length - 1;
        }
        increaseCounter(req.url, req.method);
        return response[responseIndex];
      }
      return response;
    });
    handled = true;
  }

  if (handled) {
    logger.debug(`Handled request: [${req.method}] ${req.url}`);
  }
};

healthcheck(server);
server.use(urlencoded({ extended: true }));
server.use(json());
server.use(
  createProxyMiddleware({
    target: process.env["ROTKI_URL"],
    onProxyRes,
    onProxyReq,
    ws: true,
  })
);

server.listen(port, (): void => {
  logger.info(`Proxy server is running at http://localhost:${port}`);
});
