import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuApp } from "../src/app.js";
import { StateStore } from "../src/state.js";

async function stateDir() {
  const dir = await mkdtemp(join(tmpdir(), "dsh-feishu-title-"));
  return {
    file: join(dir, "state.json"),
    async cleanup() {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function bind(store, { threadId, rootId, cardMessageId, style, sessionId = "session-1", title = "旧标题" }) {
  store.bindThread({
    threadId,
    rootId,
    sessionId,
    chatId: "oc_1",
    openId: "ou_1",
    anchorMessageId: `anchor-${cardMessageId}`,
    cardMessageId,
    style,
    title,
  });
}

test("threadsForSession lists every bound topic newest first and keeps its root card", async () => {
  const { file, cleanup } = await stateDir();
  try {
    const store = new StateStore({ file });
    await store.load();
    bind(store, { threadId: "omt_1", rootId: "om_1", cardMessageId: "om_card_1", style: "created" });
    bind(store, { rootId: "om_2", cardMessageId: "om_card_2", style: "resumed" });
    bind(store, { threadId: "omt_other", cardMessageId: "om_card_other", style: "created", sessionId: "session-2" });
    // The same root card can be reached through a second alias; list it once.
    bind(store, { threadId: "omt_1_reentered", cardMessageId: "om_card_1", style: "entered" });
    await store.saving;

    const links = store.threadsForSession("session-1");
    assert.deepEqual(
      links.map((link) => [link.cardMessageId, link.style]),
      [
        ["om_card_1", "entered"],
        ["om_card_2", "resumed"],
      ],
    );
    assert.deepEqual(
      store.threadsForSession("session-2").map((link) => link.cardMessageId),
      ["om_card_other"],
    );

    store.setThreadTitle("om_card_1", "更新后的标题");
    await store.saving;

    const reloaded = new StateStore({ file });
    await reloaded.load();
    const persisted = reloaded.threadsForSession("session-1");
    assert.deepEqual(
      persisted.map((link) => [link.cardMessageId, link.style, link.title]),
      [
        ["om_card_1", "entered", "更新后的标题"],
        ["om_card_2", "resumed", "旧标题"],
      ],
    );
  } finally {
    await cleanup();
  }
});

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createApp(stateFile) {
  return new FeishuApp({
    ctx: {},
    config: { stateFile, signSecret: "test-secret" },
    rawConfig: {},
    log: fakeLog(),
  });
}

function formAction(values) {
  return {
    messageId: "om_form",
    chatId: "oc_1",
    operatorOpenId: "ou_1",
    formValue: { dir: "/tmp", ...values },
  };
}

function formHarness(file) {
  const created = [];
  const app = createApp(file);
  app.bridge = {
    async createSession(options) {
      created.push(options);
      return "session-1";
    },
    async viewOf() {
      return { sessionId: "session-1", title: "第一条消息总结出的标题", cwd: "/tmp", updatedAt: 0, running: false };
    },
    permissionCatalog() {
      return { options: [] };
    },
  };
  app.sender = {
    async sendCard() {
      return { ok: true, messageId: "om_topic_root" };
    },
    async replyText() {
      return { ok: true, messageId: "om_placeholder", threadId: "omt_1" };
    },
    async patchCard() {
      return { ok: true };
    },
  };
  return { app, created };
}

test("a new-session form without a title does not rename the session to a timestamp", async () => {
  const { file, cleanup } = await stateDir();
  try {
    const { app, created } = formHarness(file);
    await app.state.load();
    const result = await app.createFromForm(formAction({ title: "" }));
    assert.equal(result.toast.type, "success");
    assert.equal(created.length, 1);
    assert.ok(!created[0].title, `unexpected title: ${created[0].title}`);
    await app.state.saving;
  } finally {
    await cleanup();
  }
});

test("a hand-written form title is still applied to the new session", async () => {
  const { file, cleanup } = await stateDir();
  try {
    const { app, created } = formHarness(file);
    await app.state.load();
    await app.createFromForm(formAction({ title: "  手填的标题  " }));
    assert.equal(created[0].title, "手填的标题");
    await app.state.saving;
  } finally {
    await cleanup();
  }
});

function titleHarness(file) {
  const patches = [];
  const app = createApp(file);
  app.bridge = {
    async viewOf(sessionId) {
      return { sessionId, title: "旧标题", cwd: "/tmp", updatedAt: 0, running: false };
    },
  };
  app.sender = {
    async patchCard(messageId, card) {
      patches.push({ messageId, card });
      return { ok: true };
    },
  };
  return { app, patches };
}

test("a session title event patches the topic root card bound to that session", async () => {
  const { file, cleanup } = await stateDir();
  try {
    const { app, patches } = titleHarness(file);
    await app.state.load();
    bind(app.state, { threadId: "omt_a", cardMessageId: "om_a", style: "created" });
    bind(app.state, { rootId: "om_r", cardMessageId: "om_b", style: "resumed" });
    bind(app.state, {
      threadId: "omt_other",
      cardMessageId: "om_other",
      sessionId: "session-2",
      title: "别的会话",
    });
    await app.state.saving;

    await app.handleSessionTitle({ id: "session-1" }, { type: "session/title", data: { title: "新标题" } });

    const byCard = new Map(patches.map(({ messageId, card }) => [messageId, card]));
    assert.deepEqual([...byCard.keys()].sort(), ["om_a", "om_b"]);
    assert.equal(byCard.get("om_a").header.title.content, "新标题");
    assert.equal(byCard.get("om_b").header.title.content, "新标题");
    assert.match(JSON.stringify(byCard.get("om_a")), /会话已创建/);
    assert.match(JSON.stringify(byCard.get("om_b")), /已在这个话题里接入/);
    assert.deepEqual(
      app.state.threadsForSession("session-2").map((link) => link.title),
      ["别的会话"],
    );

    await app.state.saving;
    const reloaded = new StateStore({ file });
    await reloaded.load();
    assert.deepEqual(
      reloaded.threadsForSession("session-1").map((link) => link.title),
      ["新标题", "新标题"],
    );
  } finally {
    await cleanup();
  }
});

test("only a real title change patches topic cards again", async () => {
  const { file, cleanup } = await stateDir();
  try {
    const { app, patches } = titleHarness(file);
    await app.state.load();
    bind(app.state, { threadId: "omt_a", cardMessageId: "om_a", style: "created" });
    await app.state.saving;

    await app.handleSessionTitle({ id: "session-1" }, { type: "session/title", data: { title: "新标题" } });
    assert.equal(patches.length, 1);

    await app.handleSessionTitle({ id: "session-1" }, { type: "session/title", data: { title: "新标题" } });
    await app.handleSessionTitle({ id: "session-1" }, { type: "turn/start", data: {} });
    await app.handleSessionTitle({ id: "session-2" }, { type: "session/title", data: { title: "别的标题" } });
    assert.equal(patches.length, 1);

    // The LLM title arrives after the deterministic fallback and replaces it.
    await app.handleSessionTitle({ id: "session-1" }, { type: "session/title", data: { title: "更好的标题" } });
    assert.deepEqual(patches.map(({ card }) => card.header.title.content), ["新标题", "更好的标题"]);
  } finally {
    await cleanup();
  }
});

test("a state file without title-propagation fields still loads", async () => {
  const { file, cleanup } = await stateDir();
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        ownerOpenId: "",
        threads: {
          omt_old: {
            sessionId: "session-old",
            chatId: "oc_1",
            openId: "ou_1",
            anchorMessageId: "om_anchor",
            title: "旧话题",
            createdAt: 1,
          },
        },
        roots: { om_root: "omt_old" },
        sessionThreads: { "session-old": ["omt_old"] },
      }),
    );
    const store = new StateStore({ file });
    await store.load();
    const [link] = store.threadsForSession("session-old");
    assert.equal(link.sessionId, "session-old");
    assert.equal(link.cardMessageId, "");
    assert.equal(link.style, "");
    assert.equal(store.sessionForRoot("om_root"), "session-old");
  } finally {
    await cleanup();
  }
});
