import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuApp } from "../src/app.js";
import { isBotMention } from "../src/feishu/events.js";
import { createSigner } from "../src/security.js";

const BOT_OPEN_ID = "ou_bot";

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function p2pMessage(overrides = {}) {
  return {
    eventId: "evt_mention",
    messageId: "om_mention",
    chatId: "oc_p2p",
    chatType: "p2p",
    messageType: "text",
    text: "帮我看看这个",
    attachments: [],
    senderOpenId: "ou_1",
    createTime: "",
    threadId: undefined,
    rootId: undefined,
    mentions: [{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "DSH" }],
    ...overrides,
  };
}

function groupMessage(overrides = {}) {
  return p2pMessage({ chatId: "oc_group", chatType: "group", ...overrides });
}

function quicknewButton(card) {
  const elements = card.body?.elements ?? [];
  return elements.find((element) => element.tag === "button" && element.behaviors?.[0]?.value?.a === "quicknew");
}

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), "dsh-feishu-quick-"));
  const app = new FeishuApp({
    ctx: {},
    config: {
      stateFile: join(dir, "state.json"),
      signSecret: "test-secret",
      defaultDirectory: "/srv/work",
      defaultPermissionPreset: "workspace-write",
      defaultModel: { provider: "p", model: "m" },
      allowUsers: ["ou_1"],
      acceptAttachments: true,
      attachmentMaxBytes: 1_000_000,
      staleMessageMs: 0,
      busyDelivery: "queue",
    },
    rawConfig: {},
    log: fakeLog(),
  });
  await app.state.load();
  app.botOpenId = BOT_OPEN_ID;

  const created = [];
  const prompts = [];
  const begun = [];
  const replies = [];
  const texts = [];
  const sends = [];
  const patches = [];
  const finishes = [];
  const downloads = [];
  const bridge = {
    async createSession(options) {
      created.push(options);
      return "session-1";
    },
    async viewOf(sessionId) {
      return { sessionId, title: "单聊里问的问题", cwd: "/srv/work", updatedAt: 0, running: false };
    },
    async sessionBrief() {
      return undefined;
    },
    isRunning() {
      return false;
    },
    async prompt(sessionId, content, mode, requestId) {
      prompts.push({ sessionId, content, mode, requestId });
      return { accepted: true };
    },
    async uploadFile(_sessionId, _bytes, name) {
      return { receiptId: `rc_${name}` };
    },
  };
  app.bridge = bridge;
  app.sender = {
    async replyCard(anchor, card, options = {}) {
      replies.push({ anchor, card, options });
      if (options.replyInThread) {
        return { ok: true, messageId: "om_topic_root", threadId: "omt_topic", rootId: "om_root" };
      }
      return { ok: true, messageId: `om_reply_${replies.length}` };
    },
    async replyText(anchor, text, options = {}) {
      texts.push({ anchor, text, options });
      if (options.replyInThread) {
        return { ok: true, messageId: "om_placeholder", threadId: "omt_topic" };
      }
      return { ok: true, messageId: `om_text_${texts.length}` };
    },
    async sendCard(chatId, card) {
      sends.push({ chatId, card });
      return { ok: true, messageId: `om_sent_${sends.length}` };
    },
    async patchCard(messageId, card) {
      patches.push({ messageId, card });
      return { ok: true };
    },
    async downloadResource(messageId, fileKey, kind) {
      downloads.push({ messageId, fileKey, kind });
      return {
        ok: true,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        contentType: "image/png",
      };
    },
  };
  app.runs = {
    active() {
      return undefined;
    },
    async beginPrompt(sessionId, info) {
      begun.push({ sessionId, ...info });
      return {
        sessionId,
        messageId: "om_topic_first",
        threadId: info.openThread ? "omt_run" : info.threadId,
        finished: false,
      };
    },
    finish(run, status, error) {
      finishes.push({ sessionId: run?.sessionId, status, error });
    },
  };
  app.questions = { async tryAnswerText() { return false; } };
  app.approvals = { hasPending() { return false; } };
  return {
    app,
    bridge,
    sender: app.sender,
    created,
    prompts,
    begun,
    replies,
    texts,
    sends,
    patches,
    finishes,
    downloads,
    async cleanup() {
      await app.state.saving;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test("isBotMention only matches the bot's own open_id", () => {
  assert.equal(isBotMention(p2pMessage(), BOT_OPEN_ID), true);
  assert.equal(isBotMention(groupMessage(), BOT_OPEN_ID), true);
  assert.equal(
    isBotMention(p2pMessage({ mentions: [{ id: { open_id: "ou_someone_else" } }] }), BOT_OPEN_ID),
    false,
  );
  assert.equal(isBotMention(p2pMessage({ mentions: [] }), BOT_OPEN_ID), false);
  assert.equal(isBotMention(p2pMessage({ mentions: undefined }), BOT_OPEN_ID), false);
  assert.equal(isBotMention(p2pMessage(), ""), false);
});

test("the bot keeps no open_id when the identity lookup fails", async () => {
  const harness = await createHarness();
  try {
    const requests = [];
    harness.app.client = {
      async request(options) {
        requests.push(options);
        return { code: 0, msg: "success", bot: { open_id: BOT_OPEN_ID } };
      },
    };
    harness.app.botOpenId = "";
    await harness.app.refreshBotOpenId();
    assert.equal(harness.app.botOpenId, BOT_OPEN_ID);
    assert.equal(requests[0].url, "/open-apis/bot/v3/info");

    // The credentials were replaced and the lookup failed: an id from the
    // previous app must not survive and match another app's mentions.
    harness.app.client = {
      async request() {
        throw new Error("network down");
      },
    };
    await harness.app.refreshBotOpenId();
    assert.equal(harness.app.botOpenId, "");
  } finally {
    await harness.cleanup();
  }
});

test("@ in the private main chat creates a session, opens a topic and delivers the message", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({
        attachments: [
          { kind: "image", fileKey: "fk_img", fileName: "shot.png" },
          { kind: "file", fileKey: "fk_doc", fileName: "notes.txt" },
        ],
      }),
    );

    assert.deepEqual(harness.created, [
      { cwd: "/srv/work", preset: "workspace-write", model: { provider: "p", model: "m" } },
    ]);

    // The topic root is the bridge's own session card, sent as a new message in
    // the main chat instead of anchoring on the user's @ message.
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].chatId, "oc_p2p");
    assert.match(JSON.stringify(harness.sends[0].card), /会话已创建/);
    assert.equal(harness.sends[0].card.header.title.content, "单聊里问的问题");

    // The first prompt's run card opens the topic; no placeholder is added.
    assert.equal(harness.texts.length, 0);
    assert.equal(harness.begun.length, 1);
    assert.equal(harness.begun[0].sessionId, "session-1");
    assert.equal(harness.begun[0].anchorMessageId, "om_sent_1");
    assert.equal(harness.begun[0].threadId, undefined);
    assert.equal(harness.begun[0].openThread, true);

    // The thread id returned by the run card is the one bound to the session.
    assert.equal(harness.app.state.sessionForThread("omt_run"), "session-1");
    assert.equal(harness.app.state.sessionForRoot("om_sent_1"), "session-1");
    const [bound] = harness.app.state.threadsForSession("session-1");
    assert.equal(bound.cardMessageId, "om_sent_1");
    assert.equal(bound.anchorMessageId, "om_topic_first");
    assert.equal(bound.style, "created");

    assert.equal(harness.prompts.length, 1);
    const prompt = harness.prompts[0];
    assert.equal(prompt.sessionId, "session-1");
    assert.equal(prompt.mode, "queue");
    assert.deepEqual(prompt.content[0], { type: "text", text: "帮我看看这个" });
    assert.equal(prompt.content[1].type, "image");
    assert.equal(prompt.content[1].mediaType, "image/png");
    assert.equal(prompt.content[1].name, "shot.png");
    assert.equal(prompt.content[2].type, "file");
    assert.equal(prompt.content[2].receiptId, "rc_notes.txt");
  } finally {
    await harness.cleanup();
  }
});

test("the quick topic is bound before the first prompt is submitted", async () => {
  const harness = await createHarness();
  try {
    let boundAtPrompt;
    harness.bridge.prompt = async () => {
      boundAtPrompt = harness.app.state.sessionForThread("omt_run");
      return { accepted: true };
    };
    await harness.app.handleMessage(p2pMessage({ eventId: "evt_order", messageId: "om_order" }));
    // A user can write in the topic while attachments are still downloading;
    // routing must already know which session owns it.
    assert.equal(boundAtPrompt, "session-1");
  } finally {
    await harness.cleanup();
  }
});

test("a bare @ creates a session with a timestamp topic name and a placeholder topic message", async () => {
  const harness = await createHarness();
  try {
    // A session created a moment ago has no title yet, so it is blank.
    harness.bridge.viewOf = async (sessionId) => ({
      sessionId,
      title: "(未命名会话)",
      blank: true,
      cwd: "/srv/work",
      updatedAt: 0,
      running: false,
    });
    await harness.app.handleMessage(
      p2pMessage({ text: "", eventId: "evt_bare", messageId: "om_bare" }),
    );

    assert.equal(harness.created.length, 1);
    assert.equal(harness.sends.length, 1);
    const header = harness.sends[0].card.header.title.content;
    assert.match(header, /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(harness.sends[0].card.header.template, "green");

    // No run card exists, so one short placeholder opens the topic.
    assert.equal(harness.texts.length, 1);
    assert.equal(harness.texts[0].anchor, "om_sent_1");
    assert.equal(harness.texts[0].text, "在话题里直接说话即可");
    assert.deepEqual(harness.texts[0].options, { replyInThread: true });

    assert.equal(harness.app.state.sessionForThread("omt_topic"), "session-1");
    assert.equal(harness.app.state.sessionForRoot("om_sent_1"), "session-1");
    const [bound] = harness.app.state.threadsForSession("session-1");
    assert.equal(bound.cardMessageId, "om_sent_1");
    assert.equal(bound.anchorMessageId, "om_placeholder");
    assert.equal(bound.title, header);
    assert.equal(bound.style, "created");

    // The card is the only feedback: no empty or placeholder prompt.
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.begun.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a topic reply without a thread id falls back to the message metadata", async () => {
  const harness = await createHarness();
  try {
    harness.sender.replyText = async (anchor, text, options = {}) => {
      harness.texts.push({ anchor, text, options });
      return { ok: true, messageId: "om_placeholder" };
    };
    harness.sender.getMessageMeta = async (messageId) => {
      assert.equal(messageId, "om_placeholder");
      return { threadId: "omt_meta" };
    };
    await harness.app.handleMessage(
      p2pMessage({ text: "", eventId: "evt_meta", messageId: "om_meta" }),
    );

    assert.equal(harness.app.state.sessionForThread("omt_meta"), "session-1");
    const [bound] = harness.app.state.threadsForSession("session-1");
    assert.equal(bound.cardMessageId, "om_sent_1");
    assert.equal(bound.anchorMessageId, "om_placeholder");
  } finally {
    await harness.cleanup();
  }
});

test("an @ with only attachments counts as a prompt", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({
        messageType: "post",
        text: "",
        attachments: [{ kind: "image", fileKey: "fk_img" }],
        eventId: "evt_attachment_only",
        messageId: "om_attachment_only",
      }),
    );

    assert.equal(harness.created.length, 1);
    assert.equal(harness.prompts.length, 1);
    assert.deepEqual(
      harness.prompts[0].content.map((part) => part.type),
      ["image"],
    );
  } finally {
    await harness.cleanup();
  }
});

test("@ + /help in the private chat still runs the command", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ text: "/help", eventId: "evt_help", messageId: "om_help" }),
    );
    assert.equal(harness.created.length, 0);
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.sends.length, 1);
    assert.match(JSON.stringify(harness.sends[0].card), /DSH 飞书桥接/);
  } finally {
    await harness.cleanup();
  }
});

test("a plain message in the private main chat gets the management card", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ text: "帮我看看这个", mentions: [], eventId: "evt_main", messageId: "om_main" }),
    );
    assert.equal(harness.created.length, 0);
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].card.header.title.content, "🧭 管理台");
  } finally {
    await harness.cleanup();
  }
});

test("a plain main-chat message offers a quicknew button carrying only a signed token", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ text: "帮我看看这个", mentions: [], eventId: "evt_main", messageId: "om_main_task" }),
    );
    const card = harness.sends[0].card;
    const text = JSON.stringify(card);
    assert.match(text, /收到一条任务/);
    assert.match(text, /帮我看看这个/);
    const buttonValue = quicknewButton(card)?.behaviors[0].value;
    assert.equal(buttonValue.a, "quicknew");
    assert.equal(typeof buttonValue.k, "string");
    // The whole prompt stays in memory: the button carries the token only.
    assert.deepEqual(Object.keys(buttonValue).sort(), ["a", "k"]);
  } finally {
    await harness.cleanup();
  }
});

test("a message with no text and no attachments offers no quicknew button", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ text: "", attachments: [], mentions: [], eventId: "evt_empty", messageId: "om_empty" }),
    );
    assert.equal(harness.sends.length, 1);
    assert.equal(quicknewButton(harness.sends[0].card), undefined);
  } finally {
    await harness.cleanup();
  }
});

test("@ bypasses consoleIntent recognition and the management card", async () => {
  const harness = await createHarness();
  try {
    const completions = [];
    harness.app.config.consoleIntent = true;
    harness.bridge.completeText = async (options) => {
      completions.push(options);
      return '{"intent":"chat"}';
    };
    await harness.app.handleMessage(p2pMessage());

    // No thinking card, no intent model call: the mention goes straight to the
    // quick session. The only card is the session card that roots the topic.
    assert.equal(completions.length, 0);
    assert.equal(harness.created.length, 1);
    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.sends.length, 1);
    assert.match(JSON.stringify(harness.sends[0].card), /会话已创建/);
    assert.equal(harness.patches.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("an @ in a bound topic continues that session instead of creating a new one", async () => {
  const harness = await createHarness();
  try {
    harness.app.state.bindThread({
      threadId: "omt_bound",
      rootId: "om_root_bound",
      sessionId: "session-9",
      chatId: "oc_p2p",
      openId: "ou_1",
      anchorMessageId: "om_bound_anchor",
      title: "已有会话",
    });
    await harness.app.handleMessage(
      p2pMessage({ threadId: "omt_bound", text: "继续", eventId: "evt_topic", messageId: "om_in_topic" }),
    );
    assert.equal(harness.created.length, 0);
    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.prompts[0].sessionId, "session-9");
    assert.equal(harness.begun[0].anchorMessageId, "om_in_topic");
  } finally {
    await harness.cleanup();
  }
});

test("/steer and /queue submit into the session's thread with their own mode", async () => {
  const harness = await createHarness();
  try {
    harness.app.state.bindThread({
      threadId: "omt_bound",
      rootId: "om_root_bound",
      sessionId: "session-9",
      chatId: "oc_p2p",
      openId: "ou_1",
      anchorMessageId: "om_bound_anchor",
      title: "已有会话",
    });

    await harness.app.handleMessage(
      p2pMessage({ threadId: "omt_bound", text: "/steer 换个方向", eventId: "evt_steer", messageId: "om_steer" }),
    );
    // The run card and answer must land in the bound topic, not the main chat,
    // and the command decides how a running turn is delivered.
    assert.equal(harness.begun.at(-1).threadId, "omt_bound");
    assert.equal(harness.prompts.at(-1).mode, "steer");
    assert.deepEqual(harness.prompts.at(-1).content, [{ type: "text", text: "换个方向" }]);

    // A queue request stays a queue even while the session is busy.
    harness.app.config.busyDelivery = "steer";
    harness.bridge.isRunning = () => true;
    await harness.app.handleMessage(
      p2pMessage({ threadId: "omt_bound", text: "/queue 排队说", eventId: "evt_queue", messageId: "om_queue" }),
    );
    assert.equal(harness.begun.at(-1).threadId, "omt_bound");
    assert.equal(harness.prompts.at(-1).mode, "queue");
  } finally {
    await harness.cleanup();
  }
});

test("an unbound topic creates a session and the title later patches its root card", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({
        threadId: "omt_new",
        rootId: "om_root_new",
        eventId: "evt_topic_plain",
        messageId: "om_topic_plain",
        text: "在这个话题里开个会话",
        mentions: [],
      }),
    );

    assert.equal(harness.created.length, 1);
    assert.equal(harness.app.state.sessionForThread("omt_new"), "session-1");
    assert.equal(harness.app.state.sessionForRoot("om_root_new"), "session-1");
    const [link] = harness.app.state.threadsForSession("session-1");
    assert.equal(link.cardMessageId, "om_reply_1");
    assert.equal(link.style, "created");
    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.prompts[0].sessionId, "session-1");

    await harness.app.handleSessionTitle(
      { id: "session-1" },
      { type: "session/title", data: { title: "话题里的新标题" } },
    );

    assert.equal(harness.patches.length, 1);
    assert.equal(harness.patches[0].messageId, "om_reply_1");
    assert.equal(harness.patches[0].card.header.title.content, "话题里的新标题");
    assert.match(JSON.stringify(harness.patches[0].card), /会话已创建/);
  } finally {
    await harness.cleanup();
  }
});

test("an @ in an unbound topic creates the session in that topic, not a quick session", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({
        threadId: "omt_mention_new",
        rootId: "om_root_mention_new",
        eventId: "evt_topic_mention",
        messageId: "om_topic_mention",
        text: "话题里 @ 一下也要照常建会话",
      }),
    );

    assert.equal(harness.created.length, 1);
    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.app.state.sessionForThread("omt_mention_new"), "session-1");
    // The topic path replies inside the existing topic; it does not open a
    // second topic under the mention.
    assert.equal(harness.replies.filter((entry) => entry.options.replyInThread).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("non-p2p events are ignored entirely", async () => {
  const harness = await createHarness();
  try {
    harness.app.state.bindThread({
      threadId: "omt_group",
      rootId: "om_root_group",
      sessionId: "session-g",
      chatId: "oc_group",
      openId: "ou_1",
      anchorMessageId: "om_group_anchor",
      title: "群里的会话",
    });
    // A main-chat mention is not a request, a bound topic is not followed, and
    // a command is not answered: the bridge is p2p-only.
    await harness.app.handleMessage(groupMessage());
    await harness.app.handleMessage(
      groupMessage({ threadId: "omt_group", text: "继续", eventId: "evt_group_topic", messageId: "om_group_topic" }),
    );
    await harness.app.handleMessage(
      groupMessage({ text: "/help", eventId: "evt_group_help", messageId: "om_group_help" }),
    );

    assert.equal(harness.created.length, 0);
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.sends.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("an unauthorized sender cannot start a quick session", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ senderOpenId: "ou_stranger", eventId: "evt_bad", messageId: "om_bad" }),
    );
    assert.equal(harness.created.length, 0);
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.sends.length, 0);
    assert.equal(harness.prompts.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a failed quick session answers with an error card under the @ message", async () => {
  const harness = await createHarness();
  try {
    harness.bridge.createSession = async () => {
      throw new Error("工作目录不可写");
    };
    await harness.app.handleMessage(p2pMessage());
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.replies.length, 1);
    assert.equal(harness.replies[0].anchor, "om_mention");
    assert.equal(harness.replies[0].card.header.title.content, "❌ 无法创建会话");
    assert.match(JSON.stringify(harness.replies[0].card), /工作目录不可写/);
  } finally {
    await harness.cleanup();
  }
});

test("a quick topic that cannot be opened leaves no binding and answers with an error card", async () => {
  const harness = await createHarness();
  try {
    harness.sender.replyText = async (anchor, text, options = {}) => {
      harness.texts.push({ anchor, text, options });
      if (options.replyInThread) return { ok: false, error: "无法创建话题" };
      return { ok: true, messageId: "om_text" };
    };
    await harness.app.handleMessage(
      p2pMessage({ text: "", eventId: "evt_topic_fail", messageId: "om_topic_fail" }),
    );
    assert.equal(harness.created.length, 1);
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.prompts.length, 0);
    // The root card was sent before the topic failed, so the error lands under
    // the user's message instead of the session card.
    assert.equal(harness.replies.length, 1);
    assert.equal(harness.replies[0].anchor, "om_topic_fail");
    assert.equal(harness.replies[0].card.header.title.content, "❌ 无法创建会话");
    assert.match(JSON.stringify(harness.replies[0].card), /无法创建话题/);
    assert.equal(harness.app.state.threadsForSession("session-1").length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a quick topic the run card cannot open leaves no binding and submits nothing", async () => {
  const harness = await createHarness();
  try {
    // The run card is what opens the topic for a prompt-bearing quick session,
    // so a failed send leaves the run without a thread id.
    harness.app.runs.beginPrompt = async (sessionId, info) => {
      harness.begun.push({ sessionId, ...info });
      return { sessionId, messageId: "", threadId: undefined, error: "运行卡片发送失败", finished: false };
    };
    await harness.app.handleMessage(
      p2pMessage({ eventId: "evt_run_fail", messageId: "om_run_fail" }),
    );

    assert.equal(harness.created.length, 1);
    // Submitting anyway would answer in the main chat (or lose the answer in
    // card mode), and the binding would point at no topic.
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.app.state.sessionForRoot("om_sent_1"), undefined);
    assert.equal(harness.app.state.threadsForSession("session-1").length, 0);
    assert.deepEqual(harness.finishes.map((entry) => entry.status), ["error"]);

    // The error belongs on the session root card, which is the only surface the
    // user has for this session.
    const failure = harness.replies.find((entry) => entry.anchor === "om_sent_1");
    assert.ok(failure);
    assert.equal(failure.card.header.title.content, "❌ 无法打开话题");
    assert.match(JSON.stringify(failure.card), /运行卡片发送失败/);
  } finally {
    await harness.cleanup();
  }
});

test("clicking quicknew creates a session from the stored message in a topic anchored at the card", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({
        text: "帮我看看这个",
        attachments: [
          { kind: "image", fileKey: "fk_img", fileName: "shot.png" },
          { kind: "file", fileKey: "fk_doc", fileName: "notes.txt" },
        ],
        mentions: [],
        eventId: "evt_main_task",
        messageId: "om_main_task",
      }),
    );
    const buttonValue = quicknewButton(harness.sends[0].card).behaviors[0].value;

    const result = await harness.app.handleCardAction({
      value: buttonValue,
      messageId: "om_sent_1",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
    });

    assert.equal(result.toast.type, "success");
    assert.deepEqual(harness.created, [
      { cwd: "/srv/work", preset: "workspace-write", model: { provider: "p", model: "m" } },
    ]);
    // The clicked management card stores the message; the session card sent
    // after it is the topic root, not the clicked card.
    assert.equal(harness.sends.length, 2);
    assert.match(JSON.stringify(harness.sends[1].card), /会话已创建/);
    assert.equal(harness.sends[1].card.header.title.content, "单聊里问的问题");
    assert.equal(harness.texts.length, 0);
    assert.equal(harness.app.state.sessionForThread("omt_run"), "session-1");
    assert.equal(harness.app.state.sessionForRoot("om_sent_2"), "session-1");
    const [bound] = harness.app.state.threadsForSession("session-1");
    assert.equal(bound.cardMessageId, "om_sent_2");

    // The prompt keeps the original message identity, which attachment
    // downloads and the request id are keyed to.
    assert.equal(harness.begun.length, 1);
    assert.equal(harness.begun[0].anchorMessageId, "om_sent_2");
    assert.equal(harness.begun[0].threadId, undefined);
    assert.equal(harness.begun[0].openThread, true);
    assert.equal(harness.prompts.length, 1);
    const prompt = harness.prompts[0];
    assert.equal(prompt.sessionId, "session-1");
    assert.deepEqual(prompt.content[0], { type: "text", text: "帮我看看这个" });
    assert.equal(prompt.content[1].type, "image");
    assert.equal(prompt.content[1].name, "shot.png");
    assert.equal(prompt.content[2].type, "file");
    assert.equal(prompt.content[2].receiptId, "rc_notes.txt");
    assert.deepEqual(harness.downloads.map((entry) => entry.messageId), ["om_main_task", "om_main_task"]);
    assert.match(prompt.requestId, /^feishu-om_main_task-/);
  } finally {
    await harness.cleanup();
  }
});

test("clicking the same quicknew token twice creates exactly one session", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ text: "只建一次", mentions: [], eventId: "evt_once", messageId: "om_once" }),
    );
    const action = {
      value: quicknewButton(harness.sends[0].card).behaviors[0].value,
      messageId: "om_sent_1",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
    };

    const first = await harness.app.handleCardAction(action);
    const second = await harness.app.handleCardAction(action);

    assert.equal(first.toast.type, "success");
    assert.equal(second.toast.type, "error");
    assert.match(second.toast.content, /已经用过/);
    assert.doesNotMatch(second.toast.content, /过期/);
    assert.equal(harness.created.length, 1);
    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.sends.filter((entry) => /会话已创建/.test(JSON.stringify(entry.card))).length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("an expired or forged quicknew token creates nothing and answers with an expiry toast", async () => {
  const harness = await createHarness();
  try {
    const expired = harness.app.signer.sign({ q: "quicknew", exp: Date.now() - 1_000 });
    const forged = createSigner("another-secret").sign({ q: "quicknew" });
    for (const token of [expired, forged]) {
      const result = await harness.app.handleCardAction({
        value: { a: "quicknew", k: token },
        messageId: "om_sent_1",
        chatId: "oc_p2p",
        operatorOpenId: "ou_1",
      });
      assert.equal(result.toast.type, "error");
      assert.match(result.toast.content, /过期/);
      assert.doesNotMatch(result.toast.content, /已经用过/);
    }
    assert.equal(harness.created.length, 0);
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.replies.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a token minted before a restart reads as expired, not already used", async () => {
  const before = await createHarness();
  const after = await createHarness();
  try {
    await before.app.handleMessage(
      p2pMessage({ text: "重启前发的任务", mentions: [], eventId: "evt_restart", messageId: "om_restart" }),
    );
    const token = quicknewButton(before.sends[0].card).behaviors[0].value.k;

    // Same signSecret, fresh process: the signature still verifies but the
    // in-memory message is gone, which must read as expiry.
    const result = await after.app.handleCardAction({
      value: { a: "quicknew", k: token },
      messageId: "om_sent_1",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
    });

    assert.equal(result.toast.type, "error");
    assert.match(result.toast.content, /过期/);
    assert.doesNotMatch(result.toast.content, /已经用过/);
    assert.equal(after.created.length, 0);
    assert.equal(after.prompts.length, 0);
    assert.equal(after.replies.length, 0);
  } finally {
    await before.cleanup();
    await after.cleanup();
  }
});

test("a quick session whose run card never opens gets an error card and no binding", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(
      p2pMessage({ text: "首条消息", mentions: [], eventId: "evt_prompt_fail", messageId: "om_prompt_fail" }),
    );
    const action = {
      value: quicknewButton(harness.sends[0].card).behaviors[0].value,
      messageId: "om_sent_1",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
    };
    harness.app.runs.beginPrompt = async () => {
      throw new Error("运行卡创建失败");
    };

    const result = await harness.app.handleCardAction(action);

    // The session exists, so the click itself succeeded.
    assert.equal(result.toast.type, "success");
    assert.equal(harness.created.length, 1);
    // Without a thread id there is no topic to bind or answer in, so the
    // binding must not be written.
    assert.equal(harness.app.state.sessionForRoot("om_sent_2"), undefined);
    assert.equal(harness.app.state.sessionForThread("omt_run"), undefined);
    assert.equal(harness.app.state.threadsForSession("session-1").length, 0);

    // The failure card hangs off the topic root card, not the clicked card.
    const failure = harness.replies.find((entry) => entry.anchor === "om_sent_2");
    assert.ok(failure);
    assert.equal(failure.card.header.title.content, "❌ 无法打开话题");
    assert.match(JSON.stringify(failure.card), /运行卡创建失败/);
    assert.doesNotMatch(JSON.stringify(harness.replies.map((entry) => entry.card)), /无法创建会话/);
    assert.equal(harness.prompts.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a session title event renames the topic by patching its root card", async () => {
  const harness = await createHarness();
  try {
    await harness.app.handleMessage(p2pMessage({ eventId: "evt_title", messageId: "om_title" }));

    await harness.app.handleSessionTitle(
      { id: "session-1" },
      { type: "session/title", data: { title: "生成的标题" } },
    );

    assert.equal(harness.patches.length, 1);
    assert.equal(harness.patches[0].messageId, "om_sent_1");
    assert.equal(harness.patches[0].card.header.title.content, "生成的标题");
    assert.match(JSON.stringify(harness.patches[0].card), /会话已创建/);
    const [bound] = harness.app.state.threadsForSession("session-1");
    assert.equal(bound.title, "生成的标题");
  } finally {
    await harness.cleanup();
  }
});

test("the new-session form uses a timestamp topic name and a placeholder topic message", async () => {
  const harness = await createHarness();
  try {
    // A session created without a title is still blank, so it has no real topic
    // name yet.
    harness.bridge.viewOf = async (sessionId) => ({
      sessionId,
      title: "(未命名会话)",
      blank: true,
      cwd: "/srv/work",
      updatedAt: 0,
      running: false,
    });
    const result = await harness.app.createFromForm({
      messageId: "om_form",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
      formValue: { dir: "/srv/work", title: "" },
    });

    assert.equal(result.toast.type, "success");
    assert.equal(harness.created.length, 1);
    assert.equal(harness.sends.length, 1);
    const header = harness.sends[0].card.header.title.content;
    assert.match(header, /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(harness.texts.length, 1);
    assert.equal(harness.texts[0].anchor, "om_sent_1");
    assert.deepEqual(harness.texts[0].options, { replyInThread: true });

    assert.equal(harness.app.state.sessionForThread("omt_topic"), "session-1");
    assert.equal(harness.app.state.sessionForRoot("om_sent_1"), "session-1");
    const [bound] = harness.app.state.threadsForSession("session-1");
    assert.equal(bound.cardMessageId, "om_sent_1");
    assert.equal(bound.style, "created");
  } finally {
    await harness.cleanup();
  }
});

test("a hand-written form title names the topic instead of the timestamp", async () => {
  const harness = await createHarness();
  try {
    harness.bridge.viewOf = async (sessionId) => ({
      sessionId,
      title: "手填标题",
      blank: false,
      cwd: "/srv/work",
      updatedAt: 0,
      running: false,
    });
    const result = await harness.app.createFromForm({
      messageId: "om_form",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
      formValue: { dir: "/srv/work", title: "手填标题" },
    });

    assert.equal(result.toast.type, "success");
    assert.equal(harness.created[0].title, "手填标题");
    assert.equal(harness.sends[0].card.header.title.content, "手填标题");
    assert.equal(harness.texts.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("a /open entry creates exactly one topic rooted at the session card", async () => {
  const harness = await createHarness();
  try {
    harness.bridge.views = async () => [
      { sessionId: "session-7", title: "旧会话", blank: false, cwd: "/srv/work", updatedAt: 0, running: false },
    ];
    harness.bridge.viewOf = async (sessionId) => ({
      sessionId,
      title: "旧会话",
      blank: false,
      cwd: "/srv/work",
      updatedAt: 0,
      running: false,
    });

    await harness.app.handleMessage(
      p2pMessage({ text: "/open 1", mentions: [], eventId: "evt_open", messageId: "om_open" }),
    );

    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].card.header.title.content, "旧会话");
    assert.equal(harness.texts.length, 1);
    assert.equal(harness.texts[0].anchor, "om_sent_1");
    assert.deepEqual(harness.texts[0].options, { replyInThread: true });
    assert.equal(harness.app.state.sessionForThread("omt_topic"), "session-7");
    assert.equal(harness.app.state.sessionForRoot("om_sent_1"), "session-7");
    const [bound] = harness.app.state.threadsForSession("session-7");
    assert.equal(bound.cardMessageId, "om_sent_1");
    assert.equal(bound.style, "resumed");
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.begun.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a /open entry on a blank session names the topic with the timestamp", async () => {
  const harness = await createHarness();
  try {
    harness.bridge.views = async () => [
      { sessionId: "session-empty", title: "(未命名会话)", blank: true, cwd: "/srv/work", updatedAt: 0, running: false },
    ];
    harness.bridge.viewOf = async (sessionId) => ({
      sessionId,
      title: "(未命名会话)",
      blank: true,
      cwd: "/srv/work",
      updatedAt: 0,
      running: false,
    });

    await harness.app.handleMessage(
      p2pMessage({ text: "/open 1", mentions: [], eventId: "evt_open_blank", messageId: "om_open_blank" }),
    );

    // A blank session has no title to name the topic with: the timestamp is its
    // initial topic name until its first message generates one.
    const header = harness.sends[0].card.header.title.content;
    assert.match(header, /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(harness.texts.length, 1);
    assert.deepEqual(harness.texts[0].options, { replyInThread: true });
    assert.equal(harness.app.state.sessionForThread("omt_topic"), "session-empty");
    const [bound] = harness.app.state.threadsForSession("session-empty");
    assert.equal(bound.title, header);
  } finally {
    await harness.cleanup();
  }
});

test("the session-list open callback creates one topic rooted at the session card", async () => {
  const harness = await createHarness();
  try {
    harness.bridge.viewOf = async (sessionId) => ({
      sessionId,
      title: "旧会话",
      cwd: "/srv/work",
      updatedAt: 0,
      running: false,
    });

    const result = await harness.app.handleCardAction({
      value: { a: "open", s: "session-7" },
      messageId: "om_list",
      chatId: "oc_p2p",
      operatorOpenId: "ou_1",
    });

    assert.equal(result.toast.type, "success");
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].card.header.title.content, "旧会话");
    assert.equal(harness.texts.length, 1);
    assert.deepEqual(harness.texts[0].options, { replyInThread: true });
    assert.equal(harness.app.state.sessionForThread("omt_topic"), "session-7");
    assert.equal(harness.app.state.sessionForRoot("om_sent_1"), "session-7");
  } finally {
    await harness.cleanup();
  }
});

test("@ degrades to the management card when the bot's open_id is unknown", async () => {
  const harness = await createHarness();
  try {
    harness.app.botOpenId = "";
    await harness.app.handleMessage(p2pMessage());

    assert.equal(harness.created.length, 0);
    assert.equal(harness.prompts.length, 0);
    assert.equal(harness.replies.length, 0);
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].card.header.title.content, "🧭 管理台");
  } finally {
    await harness.cleanup();
  }
});
