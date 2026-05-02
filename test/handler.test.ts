/**
 * Unit tests for the broker Lambda handler.
 *
 * The handler is fully mocked at the AWS SDK and JWT-verify boundaries — we
 * verify the handler's branching, replay protection, wake-lock behaviour and
 * the resolve-env adapter wiring without standing up a real AWS env.
 *
 * Jest hoists `jest.mock(...)` calls to the top of the file, so any variable
 * referenced inside a mock factory must be either (a) declared inline in the
 * factory, or (b) named with a `mock` prefix so Jest's babel transform allows
 * the closure capture. We use the `mock`-prefix convention throughout.
 */

// Set required env vars before importing the handler.
process.env.HEREYA_CLOUD_URL = "https://cloud.hereya.test";
process.env.WORKSPACE_ID = "ws-1";
process.env.WORKSPACE_NAME = "test";
process.env.JTI_CACHE_TABLE = "JtiCache";
process.env.WAKE_LOCK_TABLE = "WakeLock";
process.env.LAUNCH_TEMPLATE_ID = "lt-123";
process.env.EC2_INSTANCE_ID = "i-abc";
process.env.EXPECTED_BROKER_AUD = "broker:ws-1";

const mockFetch = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

// --- Mock AWS SDK clients ---------------------------------------------------

const mockDdbSend = jest.fn();
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDdbSend }) },
  PutCommand: jest.fn().mockImplementation((args: unknown) => ({
    __type: "PutCommand",
    args,
  })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

const mockEc2Send = jest.fn();
jest.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: jest.fn().mockImplementation(() => ({ send: mockEc2Send })),
  DescribeInstancesCommand: jest.fn().mockImplementation((args: unknown) => ({
    __type: "DescribeInstances",
    args,
  })),
  StartInstancesCommand: jest.fn().mockImplementation((args: unknown) => ({
    __type: "StartInstances",
    args,
  })),
}));

const mockSsmSend = jest.fn();
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  PutParameterCommand: jest.fn().mockImplementation((args: unknown) => ({
    __type: "PutParameter",
    args,
  })),
}));

// --- Mock JWT verify --------------------------------------------------------

const mockVerify = jest.fn();
jest.mock("../lambda/verify-jwt", () => ({
  verifyBrokerJwt: (...args: unknown[]) => mockVerify(...args),
}));

import { handler } from "../lambda/handler";
import type { LambdaFunctionURLEvent } from "aws-lambda";

function makeEvent(opts: {
  body: unknown;
  token?: string;
}): LambdaFunctionURLEvent {
  const bodyStr =
    typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: {
      "x-hereya-broker-token": opts.token ?? "tkn",
      "content-type": "application/json",
    },
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "x",
      domainPrefix: "x",
      http: {
        method: "POST",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "1.2.3.4",
        userAgent: "test",
      },
      requestId: "req",
      routeKey: "$default",
      stage: "$default",
      time: "now",
      timeEpoch: 0,
    } as LambdaFunctionURLEvent["requestContext"],
    body: bodyStr,
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("broker handler — resolve-env happy path", () => {
  it("resolves env via adapter and PATCHes job completed", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-1",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-1",
      jobType: "resolve-env",
    });
    mockDdbSend.mockResolvedValue({}); // jti record — first-seen
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const event = makeEvent({
      body: {
        jobId: "job-1",
        jobType: "resolve-env",
        payload: { env: { DB_URL: "aws:db_url", PLAIN: "x" } },
      },
    });
    const res = await handler(event);

    expect((res as { statusCode: number }).statusCode).toBe(200);
    const callArgs = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/api/executor/jobs/job-1")
    );
    expect(callArgs).toBeDefined();
    const patchedBody = JSON.parse(callArgs![1].body as string);
    expect(patchedBody.status).toBe("completed");
    expect(patchedBody.result.env.DB_URL).toBe("RESOLVED:db_url");
    expect(patchedBody.result.env.PLAIN).toBe("x");
  });
});

describe("broker handler — heavyweight wake", () => {
  it("starts EC2 when stopped and lock acquired", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-2",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-2",
      jobType: "provision",
    });
    mockDdbSend.mockResolvedValue({});
    mockEc2Send.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === "DescribeInstances") {
        return {
          Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }],
        };
      }

      return {};
    });
    mockSsmSend.mockResolvedValue({});
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ token: "boot-jwt" }), { status: 200 })
    );

    const res = await handler(
      makeEvent({
        body: { jobId: "job-2", jobType: "provision" },
      })
    );

    expect((res as { statusCode: number }).statusCode).toBe(202);
    expect(mockFetch).toHaveBeenCalled();
    const ssmCall = mockSsmSend.mock.calls.find(
      (c) => c[0].__type === "PutParameter"
    );
    expect(ssmCall).toBeDefined();
    expect(ssmCall![0].args.Name).toBe("/hereya/bootstrap/i-abc");
    const startCall = mockEc2Send.mock.calls.find(
      (c) => c[0].__type === "StartInstances"
    );
    expect(startCall).toBeDefined();
  });

  it("returns 202 noop when EC2 already running", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-3",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-3",
      jobType: "deploy",
    });
    mockDdbSend.mockResolvedValue({});
    mockEc2Send.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === "DescribeInstances") {
        return {
          Reservations: [{ Instances: [{ State: { Name: "running" } }] }],
        };
      }

      return {};
    });

    const res = await handler(
      makeEvent({
        body: { jobId: "job-3", jobType: "deploy" },
      })
    );

    expect((res as { statusCode: number }).statusCode).toBe(202);
    expect(
      mockEc2Send.mock.calls.find((c) => c[0].__type === "StartInstances")
    ).toBeUndefined();
  });

  it("returns 202 when wake lock contended", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-4",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-4",
      jobType: "destroy",
    });
    let putCalls = 0;
    mockDdbSend.mockImplementation(async () => {
      putCalls += 1;
      if (putCalls === 1) {
        return {};
      }

      const err = new Error("conditional check failed") as Error & {
        name: string;
      };
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    const res = await handler(
      makeEvent({
        body: { jobId: "job-4", jobType: "destroy" },
      })
    );

    expect((res as { statusCode: number }).statusCode).toBe(202);
    expect(
      mockEc2Send.mock.calls.find((c) => c[0].__type === "DescribeInstances")
    ).toBeUndefined();
  });
});

describe("broker handler — replay rejection", () => {
  it("returns 401 on duplicate jti", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-dup",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-x",
      jobType: "resolve-env",
    });
    mockDdbSend.mockImplementation(async () => {
      const err = new Error("conditional check failed") as Error & {
        name: string;
      };
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    const res = await handler(
      makeEvent({ body: { jobId: "job-x", jobType: "resolve-env" } })
    );
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });
});

describe("broker handler — signature failure", () => {
  it("returns 401 when JWT verify throws jwt: error", async () => {
    mockVerify.mockRejectedValue(
      new Error("jwt: signature/verification failed")
    );
    const res = await handler(
      makeEvent({ body: { jobId: "j", jobType: "resolve-env" } })
    );
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });

  it("returns 401 when no token header", async () => {
    const event = makeEvent({ body: { jobId: "j", jobType: "resolve-env" } });
    delete (event.headers as Record<string, string>)["x-hereya-broker-token"];
    const res = await handler(event);
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });
});

describe("broker handler — resolve-env without payload", () => {
  it("returns 400 when payload missing", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-np",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "j",
      jobType: "resolve-env",
    });
    mockDdbSend.mockResolvedValue({});
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await handler(
      makeEvent({ body: { jobId: "j", jobType: "resolve-env" } })
    );
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });
});
