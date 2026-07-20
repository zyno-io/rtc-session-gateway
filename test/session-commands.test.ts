import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { Readable } from "node:stream";

import { CallRegistry } from "../src/call-registry";
import { createHttpApp, GatewayController } from "../src/http-server";
import { InvalidHttpActionError } from "../src/http-contract";
import { GatewayMediaController } from "../src/media-controller";
import { controlErrorForCommand, SessionCommandHandler } from "../src/session-commands";

test("session commands create and inspect media sessions", async () => {
  const media = new FakeMediaController();
  const commands = new SessionCommandHandler(new CallRegistry(), fakeGateway, media);

  const created = await commands.execute("session.create", { callId: "call-1" });
  assert.deepEqual(created, media.session);

  const fetched = await commands.execute("session.get", { sessionId: "media-session-1" });
  assert.deepEqual(fetched, media.session);
});

test("session commands create outbound SIP calls through the gateway", async () => {
  const calls: unknown[] = [];
  const gateway: GatewayController = {
    isConnected: true,
    createOutbound: async (params) => {
      calls.push(params);
      return { sessionId: "sip-session-1", sipCallId: "sip-call-1", sdp: "remote-sdp" };
    },
    reinvite: async () => ({ sdp: "remote-sdp" }),
    bye: async () => {},
  };
  const commands = new SessionCommandHandler(new CallRegistry(), gateway);

  const result = await commands.execute(
    "sip.createOutbound",
    {
      requestUri: "sip:15551234567@carrier.example.com",
      sdp: "local-sdp",
      headers: { "X-Test": "yes" },
      callingNumber: "18005551212",
      callingName: "ACME SUPPORT",
      auth: { username: "carrier-user", password: "carrier-password" },
    },
    { controlConnectionId: "conn-1" },
  );

  assert.deepEqual(result, {
    sessionId: "sip-session-1",
    sipCallId: "sip-call-1",
    sdp: "remote-sdp",
  });
  assert.deepEqual(calls, [
    {
      requestUri: "sip:15551234567@carrier.example.com",
      sdp: "local-sdp",
      headers: { "X-Test": "yes" },
      receiverUrl: undefined,
      controlConnectionId: "conn-1",
      callingNumber: "18005551212",
      callingName: "ACME SUPPORT",
      proxy: undefined,
      auth: { username: "carrier-user", password: "carrier-password" },
    },
  ]);
});

test("session commands require complete outbound SIP auth credentials", async () => {
  const commands = new SessionCommandHandler(new CallRegistry(), fakeGateway);

  await assert.rejects(
    commands.execute(
      "sip.createOutbound",
      {
        requestUri: "sip:15551234567@carrier.example.com",
        sdp: "local-sdp",
        auth: { username: "carrier-user" },
      },
      { controlConnectionId: "conn-1" },
    ),
    /auth\.password is required/,
  );
});

test("session commands cancel a pending outbound SIP attempt on its control connection", async () => {
  const cancellations: unknown[][] = [];
  const gateway: GatewayController = {
    ...fakeGateway,
    async cancelOutbound(outboundAttemptId, controlConnectionId) {
      cancellations.push([outboundAttemptId, controlConnectionId]);
      return { ok: true };
    },
  };
  const commands = new SessionCommandHandler(new CallRegistry(), gateway);

  assert.deepEqual(
    await commands.execute(
      "sip.cancelOutbound",
      { outboundAttemptId: "attempt-1" },
      { controlConnectionId: "conn-1" },
    ),
    { ok: true },
  );
  assert.deepEqual(cancellations, [["attempt-1", "conn-1"]]);
});

test("session commands route WebRTC and recording operations to media controller", async () => {
  const media = new FakeMediaController();
  const commands = new SessionCommandHandler(new CallRegistry(), fakeGateway, media);

  assert.deepEqual(
    await commands.execute("webrtc.createOffer", {
      sessionId: "media-session-1",
      direction: "sendrecv",
    }),
    {
      endpointId: "webrtc-1",
      sdpOffer: "offer-sdp",
    },
  );
  assert.deepEqual(
    await commands.execute("webrtc.acceptAnswer", {
      endpointId: "webrtc-1",
      sdp: "answer-sdp",
      offerGeneration: 2,
    }),
    {
      ok: true,
    },
  );
  assert.deepEqual(await commands.execute("webrtc.restartIce", { endpointId: "webrtc-1" }), {
    sdpOffer: "restart-sdp",
    offerGeneration: 3,
  });
  assert.deepEqual(await commands.execute("recording.start", { sessionId: "media-session-1" }), {
    recordingId: "rec-1",
    backendId: "rtpbridge-0",
    filePath: "/recordings/call_42.pcap",
    recordingPath: "call_42.pcap",
    downloadPath: "/recordings/rtpbridge-0/call_42.pcap",
  });
  assert.deepEqual(await commands.execute("recording.list", { startsWith: "call_", limit: 10 }), {
    recordings: [{ backendId: "rtpbridge-0", path: "call_42.pcap" }],
    total: 1,
    skip: 0,
    limit: 10,
  });
  assert.deepEqual(
    await commands.execute("recording.delete", { backendId: "rtpbridge-0", path: "call_42.pcap" }),
    { deleted: true },
  );
  assert.deepEqual(
    await commands.execute("media.gather", {
      sessionId: "media-session-1",
      endpointId: "rtp-1",
      numDigits: 1,
    }),
    {
      digits: "7",
      reason: "digits",
    },
  );
  assert.deepEqual(
    await commands.execute("media.playAndWait", {
      sessionId: "media-session-1",
      source: "https://audio.example.com/prompt.wav",
      playbackTimeoutMs: 30_000,
    }),
    { played: true },
  );
  assert.deepEqual(
    await commands.execute("media.leaveMessage", {
      sessionId: "media-session-1",
      endpointId: "rtp-1",
      messageSource: "https://audio.example.com/message.wav",
      maxWaitMs: 1000,
    }),
    {
      terminator: "silence",
      messagePlayed: true,
    },
  );
  assert.deepEqual(
    await commands.execute("media.bridge", {
      sessionId: "media-session-1",
      targetSessionId: "media-session-2",
      direction: "sendrecv",
    }),
    {
      sessionId: "media-session-1",
      endpointId: "bridge-1",
      targetSessionId: "media-session-2",
      targetEndpointId: "bridge-2",
    },
  );
  assert.deepEqual(await commands.execute("media.unbridge", { endpointId: "bridge-1" }), {
    ok: true,
  });
  assert.deepEqual(await commands.execute("dtmf.inject", { endpointId: "rtp-1", digit: "5" }), {
    ok: true,
  });
  assert.deepEqual(
    await commands.execute("endpoint.updateDirection", {
      endpointId: "webrtc-1",
      direction: "inactive",
    }),
    { ok: true },
  );

  assert.deepEqual(media.calls, [
    ["createWebrtcOffer", "media-session-1", { direction: "sendrecv" }],
    ["acceptWebrtcAnswer", "webrtc-1", { sdp: "answer-sdp", offerGeneration: 2 }],
    ["restartIce", "webrtc-1"],
    [
      "startRecording",
      "media-session-1",
      { endpointId: undefined, filePath: undefined, recordOutbound: undefined },
    ],
    ["listRecordings", { backendId: undefined, startsWith: "call_", skip: undefined, limit: 10 }],
    ["deleteRecording", "rtpbridge-0", "call_42.pcap"],
    [
      "gather",
      "media-session-1",
      {
        endpointId: "rtp-1",
        numDigits: 1,
        timeoutMs: undefined,
        interDigitTimeoutMs: undefined,
        terminator: undefined,
        sensitive: undefined,
      },
    ],
    [
      "playAndWait",
      "media-session-1",
      { source: "https://audio.example.com/prompt.wav", playbackTimeoutMs: 30_000 },
    ],
    [
      "leaveMessage",
      "media-session-1",
      {
        endpointId: "rtp-1",
        messageSource: "https://audio.example.com/message.wav",
        maxWaitMs: 1000,
        playbackTimeoutMs: undefined,
        silenceIntervalMs: undefined,
        speechThreshold: undefined,
        terminator: undefined,
      },
    ],
    ["bridge", "media-session-1", { targetSessionId: "media-session-2", direction: "sendrecv" }],
    ["unbridge", "bridge-1"],
    ["injectDtmf", "rtp-1", "5"],
    ["updateDirection", "webrtc-1", "inactive"],
  ]);
});

test("session commands validate recording pagination and header errors as bad requests", async () => {
  const commands = new SessionCommandHandler(
    new CallRegistry(),
    fakeGateway,
    new FakeMediaController(),
  );

  await assert.rejects(
    () => commands.execute("recording.list", { skip: -1 }),
    /skip must be a non-negative integer/,
  );
  await assert.rejects(
    () => commands.execute("recording.list", { limit: 0 }),
    /limit must be a positive integer/,
  );
  assert.deepEqual(
    controlErrorForCommand(new InvalidHttpActionError("headers must be an object")),
    { code: "BAD_REQUEST", message: "headers must be an object" },
  );
});

test("HTTP media endpoints use the same command surface", async () => {
  const media = new FakeMediaController();
  const server = http.createServer(createHttpApp(new CallRegistry(), fakeGateway, media));
  await listen(server);

  try {
    const created = await postJson(server, "/sessions", { callId: "call-1" });
    assert.equal(created.status, 200);
    assert.deepEqual(created.body, media.session);

    const offer = await postJson(server, "/sessions/media-session-1/webrtc/offers", {
      direction: "sendrecv",
    });
    assert.equal(offer.status, 200);
    assert.deepEqual(offer.body, { endpointId: "webrtc-1", sdpOffer: "offer-sdp" });

    const bridge = await postJson(server, "/sessions/media-session-1/media/bridge", {
      targetSessionId: "media-session-2",
      direction: "sendrecv",
    });
    assert.equal(bridge.status, 200);
    assert.deepEqual(bridge.body, {
      sessionId: "media-session-1",
      endpointId: "bridge-1",
      targetSessionId: "media-session-2",
      targetEndpointId: "bridge-2",
    });

    const unbridge = await postJson(server, "/media/bridges/bridge-1/unbridge", {});
    assert.equal(unbridge.status, 200);
    assert.deepEqual(unbridge.body, { ok: true });

    const gathered = await postJson(server, "/sessions/media-session-1/media/gather", {
      endpointId: "rtp-1",
      numDigits: 1,
    });
    assert.equal(gathered.status, 200);
    assert.deepEqual(gathered.body, { digits: "7", reason: "digits" });

    const playAndGathered = await postJson(
      server,
      "/sessions/media-session-1/media/play-and-gather",
      {
        endpointId: "rtp-1",
        source: "https://audio.example.com/menu.wav",
        numDigits: 1,
      },
    );
    assert.equal(playAndGathered.status, 200);
    assert.deepEqual(playAndGathered.body, {
      digits: "1",
      reason: "digits",
      playbackEndpointId: "file-1",
    });

    const leaveMessage = await postJson(server, "/sessions/media-session-1/media/leave-message", {
      endpointId: "rtp-1",
      messageSource: "https://audio.example.com/message.wav",
    });
    assert.equal(leaveMessage.status, 200);
    assert.deepEqual(leaveMessage.body, { terminator: "silence", messagePlayed: true });

    const dtmf = await postJson(server, "/media/endpoints/rtp-1/dtmf", { digit: "#" });
    assert.equal(dtmf.status, 200);
    assert.deepEqual(dtmf.body, { ok: true });

    const direction = await postJson(server, "/media/endpoints/webrtc-1/direction", {
      direction: "inactive",
    });
    assert.equal(direction.status, 200);
    assert.deepEqual(direction.body, { ok: true });
  } finally {
    server.close();
  }
});

test("HTTP recording proxy lists and streams backend recordings", async () => {
  const media = new FakeMediaController();
  const server = http.createServer(createHttpApp(new CallRegistry(), fakeGateway, media));
  await listen(server);

  try {
    const port = (server.address() as any).port;
    const listed = await fetch(`http://127.0.0.1:${port}/recordings?startsWith=call_`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      recordings: [{ backendId: "rtpbridge-0", path: "call_42.pcap" }],
      total: 1,
      skip: 0,
      limit: 100,
    });

    const downloaded = await fetch(
      `http://127.0.0.1:${port}/recordings/rtpbridge-0/calls/42/call_42.pcap`,
    );
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/vnd.tcpdump.pcap");
    assert.equal(await downloaded.text(), "pcap-bytes");
    assert.deepEqual(media.calls.at(-1), [
      "downloadRecording",
      "rtpbridge-0",
      "calls/42/call_42.pcap",
    ]);

    const deleted = await fetch(
      `http://127.0.0.1:${port}/recordings/rtpbridge-0/calls/42/call_42.pcap`,
      {
        method: "DELETE",
      },
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.deepEqual(media.calls.at(-1), [
      "deleteRecording",
      "rtpbridge-0",
      "calls/42/call_42.pcap",
    ]);

    const merged = await fetch(`http://127.0.0.1:${port}/recordings/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targets: [
          { backendId: "rtpbridge-0", path: "call_42__seg_0001.pcap" },
          { backendId: "rtpbridge-1", path: "call_42__seg_0002.pcap" },
        ],
      }),
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.headers.get("content-type"), "application/vnd.tcpdump.pcap");
    assert.equal(await merged.text(), "merged-pcap-bytes");
    assert.deepEqual(media.calls.at(-1), [
      "mergeRecordings",
      [
        { backendId: "rtpbridge-0", path: "call_42__seg_0001.pcap" },
        { backendId: "rtpbridge-1", path: "call_42__seg_0002.pcap" },
      ],
    ]);
  } finally {
    server.close();
  }
});

test("HTTP outbound SIP endpoint uses the same command surface", async () => {
  const calls: unknown[] = [];
  const gateway: GatewayController = {
    isConnected: true,
    createOutbound: async (params) => {
      calls.push(params);
      return { sessionId: "sip-session-1", sipCallId: "sip-call-1", sdp: "remote-sdp" };
    },
    reinvite: async () => ({ sdp: "remote-sdp" }),
    bye: async () => {},
  };
  const server = http.createServer(createHttpApp(new CallRegistry(), gateway));
  await listen(server);

  try {
    const response = await postJson(server, "/calls", {
      requestUri: "sip:15551234567@carrier.example.com",
      sdp: "local-sdp",
      receiverUrl: "https://api.example.com/calls/outbound",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      sessionId: "sip-session-1",
      sipCallId: "sip-call-1",
      sdp: "remote-sdp",
    });
    assert.deepEqual(calls, [
      {
        requestUri: "sip:15551234567@carrier.example.com",
        sdp: "local-sdp",
        headers: undefined,
        receiverUrl: "https://api.example.com/calls/outbound",
        controlConnectionId: undefined,
        callingNumber: undefined,
        callingName: undefined,
        proxy: undefined,
      },
    ]);
  } finally {
    server.close();
  }
});

test("HTTP media commands return 503 when rtpbridge is not configured", async () => {
  const server = http.createServer(createHttpApp(new CallRegistry(), fakeGateway));
  await listen(server);

  try {
    const response = await postJson(server, "/sessions", {});
    assert.equal(response.status, 503);
    assert.match(response.body.error, /RTPBRIDGE_HOST/);
  } finally {
    server.close();
  }
});

test("HTTP command and recording routes require bearer auth when configured", async () => {
  const media = new FakeMediaController();
  const server = http.createServer(
    createHttpApp(new CallRegistry(), fakeGateway, media, {
      CONTROL_AUTH_MODE: "bearer",
      CONTROL_AUTH_TOKEN: "secret-token",
    }),
  );
  await listen(server);

  try {
    const port = (server.address() as any).port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/recordings?startsWith=call_`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });

    const authorized = await fetch(`http://127.0.0.1:${port}/recordings?startsWith=call_`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {
      recordings: [{ backendId: "rtpbridge-0", path: "call_42.pcap" }],
      total: 1,
      skip: 0,
      limit: 100,
    });
  } finally {
    server.close();
  }
});

const fakeGateway: GatewayController = {
  isConnected: true,
  createOutbound: async () => ({
    sessionId: "sip-session-1",
    sipCallId: "sip-call-1",
    sdp: "remote-sdp",
  }),
  reinvite: async () => ({ sdp: "remote-sdp" }),
  bye: async () => {},
};

class FakeMediaController implements GatewayMediaController {
  calls: unknown[][] = [];
  session = {
    sessionId: "media-session-1",
    callId: "call-1",
    backendId: "rtpbridge-0",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    endpoints: [],
  };

  list = () => [this.session];
  get = (sessionId: string) => (sessionId === this.session.sessionId ? this.session : undefined);
  createSession = async () => this.session;
  destroySession = async () => {};
  createWebrtcOffer = async (sessionId: string, params?: { direction?: string }) => {
    this.calls.push(["createWebrtcOffer", sessionId, params]);
    return { endpointId: "webrtc-1", sdpOffer: "offer-sdp" };
  };
  createWebrtcFromOffer = async () => ({ endpointId: "webrtc-1", sdpAnswer: "answer-sdp" });
  acceptWebrtcAnswer = async (
    endpointId: string,
    params: { sdp: string; offerGeneration?: number },
  ) => {
    this.calls.push(["acceptWebrtcAnswer", endpointId, params]);
    return { ok: true as const };
  };
  acceptWebrtcOffer = async () => ({ sdpAnswer: "answer-sdp" });
  restartIce = async (endpointId: string) => {
    this.calls.push(["restartIce", endpointId]);
    return { sdpOffer: "restart-sdp", offerGeneration: 3 };
  };
  createRtpOffer = async () => ({ endpointId: "rtp-1", sdpOffer: "rtp-offer-sdp" });
  createRtpFromOffer = async () => ({ endpointId: "rtp-1", sdpAnswer: "rtp-answer-sdp" });
  acceptRtpAnswer = async () => ({ ok: true as const });
  rtpReinvite = async () => ({ sdpAnswer: "rtp-answer-sdp" });
  play = async () => ({ endpointId: "file-1" });
  playAndWait = async (
    sessionId: string,
    params: { source: string; playbackTimeoutMs?: number },
  ) => {
    this.calls.push(["playAndWait", sessionId, params]);
    return { played: true };
  };
  stopMedia = async () => ({ ok: true as const });
  updateDirection = async (
    endpointId: string,
    direction: "sendrecv" | "recvonly" | "sendonly" | "inactive",
  ) => {
    this.calls.push(["updateDirection", endpointId, direction]);
    return { ok: true as const };
  };
  bridge = async (
    sessionId: string,
    params: {
      targetSessionId: string;
      direction?: "sendrecv" | "recvonly" | "sendonly" | "inactive";
    },
  ) => {
    this.calls.push(["bridge", sessionId, params]);
    return {
      sessionId,
      endpointId: "bridge-1",
      targetSessionId: params.targetSessionId,
      targetEndpointId: "bridge-2",
    };
  };
  unbridge = async (endpointId: string) => {
    this.calls.push(["unbridge", endpointId]);
    return { ok: true as const };
  };
  gather = async (
    sessionId: string,
    params: {
      endpointId: string;
      numDigits?: number;
      timeoutMs?: number;
      interDigitTimeoutMs?: number;
      terminator?: string;
    },
  ) => {
    this.calls.push(["gather", sessionId, params]);
    return { digits: "7", reason: "digits" as const };
  };
  playAndGather = async (sessionId: string, params: { endpointId: string; source: string }) => {
    this.calls.push(["playAndGather", sessionId, params]);
    return { digits: "1", reason: "digits" as const, playbackEndpointId: "file-1" };
  };
  leaveMessage = async (sessionId: string, params: { endpointId: string }) => {
    this.calls.push(["leaveMessage", sessionId, params]);
    return {
      terminator: "silence" as const,
      messagePlayed: true,
    };
  };
  injectDtmf = async (endpointId: string, digit: string) => {
    this.calls.push(["injectDtmf", endpointId, digit]);
    return { ok: true as const };
  };
  startRecording = async (
    sessionId: string,
    params: { endpointId?: string; filePath: string; recordOutbound?: boolean },
  ) => {
    this.calls.push(["startRecording", sessionId, params]);
    return {
      recordingId: "rec-1",
      backendId: "rtpbridge-0",
      filePath: "/recordings/call_42.pcap",
      recordingPath: "call_42.pcap",
      downloadPath: "/recordings/rtpbridge-0/call_42.pcap",
    };
  };
  stopRecording = async () => ({
    filePath: "/tmp/rec.pcap",
    durationMs: 1000,
    packets: 10,
    backendId: "rtpbridge-0",
    recordingPath: "call_42.pcap",
    downloadPath: "/recordings/rtpbridge-0/call_42.pcap",
  });
  listRecordings = async (params?: {
    backendId?: string;
    startsWith?: string;
    skip?: number;
    limit?: number;
  }) => {
    this.calls.push(["listRecordings", params]);
    return {
      recordings: [{ backendId: "rtpbridge-0", path: "call_42.pcap" }],
      total: 1,
      skip: params?.skip ?? 0,
      limit: params?.limit ?? 100,
    };
  };
  downloadRecording = async (backendId: string, recordingPath: string) => {
    this.calls.push(["downloadRecording", backendId, recordingPath]);
    return {
      status: 200,
      headers: { "content-type": "application/vnd.tcpdump.pcap" },
      stream: Readable.from(["pcap-bytes"]),
    };
  };
  mergeRecordings = async (targets: Array<{ backendId: string; path: string }>) => {
    this.calls.push(["mergeRecordings", targets]);
    return {
      status: 200,
      headers: { "content-type": "application/vnd.tcpdump.pcap" },
      stream: Readable.from(["merged-pcap-bytes"]),
    };
  };
  deleteRecording = async (backendId: string, recordingPath: string) => {
    this.calls.push(["deleteRecording", backendId, recordingPath]);
    return { deleted: true as const };
  };
}

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function postJson(
  server: http.Server,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  const port = (server.address() as any).port;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
