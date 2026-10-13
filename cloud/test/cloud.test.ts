import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Env } from "../src/env";
import { captureGithub } from "../src/sources";
import {
	indexBatch,
	search,
	storeDocument,
	readDocument,
	vector512,
	type Document,
} from "../src/library";
import {
	reserveBrowser,
	startJob,
	processMessage,
	jobStatus,
	failureReason,
	recoverJobs,
	queueImport,
} from "../src/jobs";

const token = "test-secret-not-a-real-credential-0123456789";
test("failure diagnostics never persist provider headers, URLs or credentials", () => {
	assert.equal(
		failureReason(
			new Error(
				"Unable to create new browser: code: 429: message: secret-cookie",
			),
		),
		"browser-provider-429",
	);
	assert.equal(
		failureReason(
			new Error("page.goto: Timeout 20000ms https://x.com/?secret=credential"),
		),
		"timeout:page.goto",
	);
	assert.equal(
		failureReason(new Error("Authorization: Bearer secret-value")),
		"provider-or-processing-error",
	);
});
let mf: Miniflare;
let env: Env;
const vectors = new Map<string, VectorizeVector>();
const document = (id: string, text: string): Document => ({
	id: JSON.stringify(["github", "alice", id]),
	source: "github",
	account: "alice",
	externalId: id,
	url: `https://github.com/alice/${id}`,
	title: id,
	author: "alice",
	text,
	publishedAt: null,
	publishedAtSource: null,
	savedAt: "2026-10-01T00:00:00.000Z",
	savedAtSource: "starred-at",
	fetchedAt: "2026-10-10T00:00:00.000Z",
});
before(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			scriptPath: "dist/worker.js",
			compatibilityDate: "2026-10-10",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: { DB: "test-db" },
			queueProducers: { JOBS: "test-jobs" },
			bindings: {
				MCP_TOKEN: token,
				GITHUB_ACCOUNT: "alice",
				X_ACCOUNT: "alice",
				INSTAGRAM_ACCOUNT: "alice",
				MAX_BROWSER_LAUNCHES_PER_DAY: "2",
			},
		}),
	);
	const db = await mf.getD1Database("DB");
	await db.batch(
		unstable_splitSqlQuery(
			readFileSync("migrations/0001_library.sql", "utf8") +
				"\n" +
				readFileSync("migrations/0002_import_staging.sql", "utf8") +
				"\n" +
				readFileSync("migrations/0003_passage_updates.sql", "utf8"),
		).map((sql) => db.prepare(sql)),
	);
	env = {
		DB: db,
		AI: {
			run: async (_model: string, { text }: { text: string[] }) => ({
				data: text.map(() =>
					Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
				),
			}),
		},
		VECTORS: {
			upsert: async (items: VectorizeVector[]) => {
				items.forEach((item) => vectors.set(item.id, item));
			},
			deleteByIds: async (ids: string[]) => {
				ids.forEach((id) => vectors.delete(id));
			},
			query: async () => ({
				matches: [...vectors.values()].map((v) => ({
					id: v.id,
					score: 1,
					metadata: v.metadata,
				})),
			}),
		},
		JOBS: { send: async () => {} },
		MAX_BROWSER_LAUNCHES_PER_DAY: "2",
	} as unknown as Env;
});
after(async () => {
	await mf?.dispose();
});

test("HTTP refuses missing credentials, wrong credentials and cross-origin requests", async () => {
	assert.equal((await mf.dispatchFetch("http://localhost/mcp")).status, 401);
	assert.equal(
		(
			await mf.dispatchFetch("http://localhost/mcp", {
				headers: { Authorization: "Bearer wrong" },
			})
		).status,
		401,
	);
	assert.equal(
		(
			await mf.dispatchFetch("http://localhost/mcp", {
				headers: {
					Authorization: `Bearer ${token}`,
					Origin: "https://other.example",
				},
			})
		).status,
		403,
	);
});
test("D1 updates preserve star timestamps and pending keyword retrieval; stale vectors supply no semantic evidence", async () => {
	const doc = document(
		"memory",
		"Persistent agent memory stores past experiences and supports semantic retrieval.",
	);
	assert.deepEqual(await storeDocument(env, doc), {
		added: true,
		changed: true,
	});
	assert.deepEqual(
		await storeDocument(env, { ...doc, fetchedAt: "2026-10-10T01:00:00.000Z" }),
		{ added: false, changed: false },
	);
	assert.equal(
		(await search(env, "memory", { limit: 5, mode: "keyword" })).items.length,
		1,
	);
	await indexBatch(env);
	assert.equal(
		(await search(env, "remember", { limit: 5, mode: "semantic" })).items
			.length,
		1,
	);
	await storeDocument(env, {
		...doc,
		text: "A browser automation tool for testing Chromium",
		fetchedAt: "2026-10-10T02:00:00.000Z",
		savedAt: "2026-10-09T00:00:00.000Z",
	});
	assert.equal(
		(await search(env, "remember", { limit: 5, mode: "semantic" })).items
			.length,
		0,
	);
	assert.equal(
		(await search(env, "nonexistent", { limit: 5, mode: "hybrid" })).items
			.length,
		0,
	);
	const results = await search(env, "Chromium", {
		limit: 5,
		mode: "keyword",
		source: "github",
		account: "alice",
	});
	assert.equal(results.items.length, 1);
	assert.equal(results.items[0]!.savedAt, doc.savedAt);
	assert.equal(results.indexIncomplete, true);
	assert.equal(
		(
			await search(env, "Chromium", {
				limit: 5,
				mode: "keyword",
				account: "other",
			})
		).items.length,
		0,
	);
});
test("browser budget serializes launches and stops at a daily cap", async () => {
	const now = Date.parse("2026-10-11T00:00:00Z");
	assert.equal(await reserveBrowser(env, now), "allowed");
	assert.equal(await reserveBrowser(env, now + 1000), "rate-limit");
	assert.equal(await reserveBrowser(env, now + 21000), "allowed");
	assert.equal(await reserveBrowser(env, now + 42000), "daily-budget");
	assert.equal(await reserveBrowser(env, now + 86400000), "allowed");
});
test("overlapping hydration requests reuse a durable job", async () => {
	const [first, second] = await Promise.all([
		startJob(env, "x"),
		startJob(env, "x"),
	]);
	assert.equal(first.id, second.id);
});
test("Matryoshka dimensions are normalized and invalid vectors fail closed", () => {
	const reduced = vector512(Array.from({ length: 768 }, () => 1));
	assert.equal(reduced.length, 512);
	assert.ok(Math.abs(Math.hypot(...reduced) - 1) < 1e-10);
	assert.throws(() => vector512([1, 2]));
	assert.throws(() => vector512(Array(768).fill(0)));
});

test("source refresh preserves agent enrichment without altering captured text", async () => {
	const doc = document("enriched", "A captured source caption");
	await storeDocument(env, {
		...doc,
		metadata: {
			enrichment: {
				summary: "A keyword-heavy inferred summary",
				keywords: ["resilience"],
				model: "calling-agent",
				inferred: true,
			},
		},
	});
	await storeDocument(env, { ...doc, text: "Updated captured caption" });
	assert.equal(
		(await readDocument(env, doc.id))?.text,
		"Updated captured caption",
	);
	const results = await search(env, "resilience", {
		mode: "keyword",
		limit: 5,
	});
	assert.ok(
		results.items.some(
			(item) => item.id === doc.id && item.text.includes("Inferred summary:"),
		),
	);
});

test("failed index steps keep pending data and make the job retryable", async () => {
	const job = await startJob(env, "index");
	let retried = false;
	const original = env.VECTORS.upsert;
	env.VECTORS.upsert = async () => {
		throw new Error("simulated quota failure");
	};
	try {
		await processMessage(env, {
			body: { jobId: job.id },
			attempts: 1,
			ack: () => assert.fail("failed step must retry"),
			retry: () => {
				retried = true;
			},
		} as unknown as Message<{ jobId: string }>);
		assert.equal(retried, true);
		assert.equal((await jobStatus(env, job.id))?.status, "queued");
		assert.ok(
			(await env.DB.prepare(
				"SELECT count(*) AS n FROM passages WHERE indexed_hash IS NULL",
			).first<{ n: number }>())!.n > 0,
		);
	} finally {
		env.VECTORS.upsert = original;
	}
});

test("a capped X scan resumes its stored cursor instead of losing the backlog", async () => {
	await env.DB.prepare(
		"UPDATE jobs SET status='completed',state_json=?,result_json=? WHERE source='x'",
	)
		.bind(
			JSON.stringify({
				cursor: "resume-cursor",
				page: 2,
				maxPages: 2,
				maxItems: 10,
			}),
			JSON.stringify({ partial: true, warning: "Stopped at maxPages" }),
		)
		.run();
	const resumed = await startJob(env, "x", { maxPages: 3, maxItems: 10 });
	const stored = await env.DB.prepare("SELECT state_json FROM jobs WHERE id=?")
		.bind(resumed.id)
		.first<{ state_json: string }>();
	assert.equal(JSON.parse(stored!.state_json).cursor, "resume-cursor");
	assert.equal(JSON.parse(stored!.state_json).page, 0);
});
test("unchanged passages retain embeddings and recreated passages cancel old tombstones", async () => {
	const doc = document(
		"passage-reuse",
		"Knowledge about durable semantic retrieval and software engineering.\n".repeat(
			100,
		),
	);
	await storeDocument(env, doc);
	while ((await indexBatch(env)).count) {}
	await storeDocument(env, {
		...doc,
		metadata: { enrichment: { keywords: ["uniqueaddedtag"] } },
	});
	const rows = await env.DB.prepare(
		"SELECT indexed_hash FROM passages WHERE document_id=?",
	)
		.bind(doc.id)
		.all<{ indexed_hash: string | null }>();
	assert.ok(rows.results.some((row) => row.indexed_hash));
	assert.ok(rows.results.some((row) => !row.indexed_hash));
	assert.equal(
		(await search(env, "uniqueaddedtag", { mode: "keyword", limit: 5 }))
			.items[0]?.id,
		doc.id,
	);
	await storeDocument(env, { ...doc, text: "Short replacement" });
	assert.ok(
		(await env.DB.prepare("SELECT count(*) AS n FROM vector_tombstones").first<{
			n: number;
		}>())!.n > 0,
	);
	await storeDocument(env, doc);
	assert.equal(
		(await env.DB.prepare(
			"SELECT count(*) AS n FROM vector_tombstones WHERE id IN (SELECT id FROM passages WHERE document_id=?)",
		)
			.bind(doc.id)
			.first<{ n: number }>())!.n,
		0,
	);
});
test("a queued enrichment survives a newer source capture without replacing its text", async () => {
	const doc = document("enrichment-race", "New source content");
	await storeDocument(env, doc);
	await storeDocument(env, {
		...doc,
		text: "Old source content",
		fetchedAt: "2026-10-01T00:00:00.000Z",
		metadata: {
			enrichment: {
				keywords: ["survivingkeyword"],
				generatedAt: "2026-10-11T00:00:00.000Z",
			},
		},
	});
	assert.equal((await readDocument(env, doc.id))?.text, doc.text);
	assert.equal(
		(await search(env, "survivingkeyword", { mode: "keyword", limit: 5 }))
			.items[0]?.id,
		doc.id,
	);
});
test("a real save timestamp can improve provenance without overwriting fresher content", async () => {
	const doc = {
		...document("timestamp-quality", "New caption"),
		savedAt: "2026-10-09T00:00:00.000Z",
		savedAtSource: "first-seen",
	};
	await storeDocument(env, doc);
	await storeDocument(env, {
		...doc,
		text: "Old caption",
		fetchedAt: "2026-10-01T00:00:00.000Z",
		savedAt: "2026-09-15T00:00:00.000Z",
		savedAtSource: "starred-at",
	});
	const stored = await readDocument(env, doc.id);
	assert.equal(stored?.text, "New caption");
	assert.equal(stored?.savedAt, "2026-09-15T00:00:00.000Z");
	assert.equal(stored?.savedAtSource, "starred-at");
});
test("an oversized README retains prior content and does not block source pagination", async () => {
	const doc = {
		...document("oversized-readme", "Description\n\nCached README"),
		metadata: { readmeStart: 13, pushedAt: "older" },
	};
	await storeDocument(env, doc);
	const original = globalThis.fetch;
	globalThis.fetch = (async (input) =>
		String(input).includes("/starred?")
			? Response.json([
					{
						starred_at: doc.savedAt,
						repo: {
							node_id: doc.externalId,
							full_name: "alice/oversized",
							description: "Description",
							topics: [],
							html_url: doc.url,
							pushed_at: "newer",
							created_at: "2026-01-01T00:00:00.000Z",
						},
					},
				])
			: new Response(new Uint8Array(1048577))) as typeof fetch;
	try {
		const captured = await captureGithub(
			{ ...env, GITHUB_ACCOUNT: "alice" },
			{},
		);
		assert.equal(captured.state.page, 2);
		assert.equal(captured.partial, true);
		assert.match(captured.documents[0].text, /Cached README/);
		assert.match(captured.warnings[0], /exceeds/);
	} finally {
		globalThis.fetch = original;
	}
});
test("an older migration cannot replace fresher captured content", async () => {
	const fresh = document("fresh-content", "Current repository README");
	await storeDocument(env, fresh);
	const stale = {
		...fresh,
		text: "Outdated archived README",
		fetchedAt: "2026-10-01T00:00:00.000Z",
	};
	assert.equal((await storeDocument(env, stale)).changed, false);
	assert.equal((await readDocument(env, fresh.id))?.text, fresh.text);
});
test("accepted imports survive dispatch failure and are searchable after queued processing", async () => {
	const original = env.JOBS.send;
	env.JOBS.send = async () => {
		throw new Error("queue unavailable");
	};
	const doc = document("queued-import", "Durable migration test evidence");
	const queued = await queueImport(env, [doc]);
	assert.equal(queued.job.dispatchPending, true);
	assert.equal(await readDocument(env, doc.id), null);
	env.JOBS.send = original;
	let acknowledged = false;
	await processMessage(env, {
		body: { jobId: queued.job.id },
		attempts: 1,
		ack: () => {
			acknowledged = true;
		},
		retry: () => {
			throw new Error("unexpected retry");
		},
	} as unknown as Message<{ jobId: string }>);
	assert.equal(acknowledged, true);
	assert.equal((await readDocument(env, doc.id))?.text, doc.text);
	assert.equal(
		await env.DB.prepare("SELECT id FROM import_staging WHERE id=?")
			.bind(doc.id)
			.first(),
		null,
	);
});
test("an actual MCP client discovers tools, searches and reads evidence", async () => {
	await storeDocument(
		env,
		document("cli-test", "A library for semantic retrieval of saved bookmarks"),
	);
	const client = new Client({ name: "nalanda-test", version: "1" });
	const transport = new StreamableHTTPClientTransport(
		new URL("http://localhost/mcp"),
		{
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
			fetch: async (input, init) => {
				const response = await mf.dispatchFetch(input.toString(), {
					method: init?.method,
					headers: Object.fromEntries(new Headers(init?.headers).entries()),
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				return new Response(await response.arrayBuffer(), {
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
				});
			},
		},
	);
	await client.connect(transport);
	try {
		const tools = await client.listTools();
		assert.ok(tools.tools.some((t) => t.name === "nalanda_sync"));
		const response = await client.callTool({
			name: "nalanda_search",
			arguments: { query: "bookmarks", mode: "keyword" },
		});
		assert.ok(!response.isError);
		const evidence = JSON.parse((response.content[0] as { text: string }).text);
		assert.equal(evidence.items[0].url, "https://github.com/alice/cli-test");
		const read = await client.callTool({
			name: "nalanda_read",
			arguments: { documentId: evidence.items[0].id },
		});
		assert.ok(!read.isError);
		const invalid = await client.callTool({
			name: "nalanda_sync",
			arguments: { source: "x", maxPages: -1 },
		});
		assert.equal(invalid.isError, true);
	} finally {
		await client.close();
	}
});

test("GitHub quota failures retain actionable diagnostics without response secrets", async () => {
	const original = globalThis.fetch;
	const send = env.JOBS.send;
	const dispatched: Array<{ jobId: string; delaySeconds?: number }> = [];
	env.JOBS.send = async (body, options) => {
		dispatched.push({ jobId: body.jobId, delaySeconds: options?.delaySeconds });
		return send(body, options);
	};
	const reset = Math.floor(Date.now() / 1000) + 3600;
	globalThis.fetch = async () =>
		new Response("private response body", {
			status: 403,
			headers: {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": String(reset),
				Authorization: "Bearer secret-value",
			},
		});
	try {
		const job = await startJob(env, "github");
		let acknowledged = false;
		await processMessage({ ...env, GITHUB_ACCOUNT: "alice" }, {
			body: { jobId: job.id },
			attempts: 3,
			ack: () => {
				acknowledged = true;
			},
			retry: () => assert.fail("final attempt must finish"),
		} as unknown as Message<{ jobId: string }>);
		const stored = await jobStatus(env, job.id);
		assert.equal(acknowledged, true);
		assert.equal(stored?.status, "queued");
		assert.equal(stored?.result.partial, true);
		assert.equal(stored?.result.failureReason, "github-stars-rate-limit-403");
		assert.deepEqual(stored?.result.failureDetail, {
			provider: "github",
			operation: "stars",
			reason: "rate-limit",
			status: 403,
			retryAt: new Date(reset * 1000).toISOString(),
		});
		assert.ok(
			dispatched.some(
				(item) => item.jobId === job.id && (item.delaySeconds ?? 0) >= 3590,
			),
		);
		const count = dispatched.filter((item) => item.jobId === job.id).length;
		await env.DB.prepare("UPDATE jobs SET updated_at=? WHERE id=?")
			.bind("2026-01-01T00:00:00Z", job.id)
			.run();
		await recoverJobs(env);
		assert.equal(
			dispatched.filter((item) => item.jobId === job.id).length,
			count,
		);
		assert.doesNotMatch(
			JSON.stringify(stored),
			/secret-value|private response body|Authorization/,
		);
	} finally {
		globalThis.fetch = original;
		env.JOBS.send = send;
	}
});

test("GitHub errors distinguish invalid stars, network failures and README HTTP failures", async () => {
	const original = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response("invalid-json");
		await assert.rejects(
			captureGithub({ ...env, GITHUB_ACCOUNT: "alice" }, {}),
			(error) => failureReason(error) === "github-stars-invalid-response",
		);
		globalThis.fetch = async () => {
			throw new Error("private URL or credentials");
		};
		await assert.rejects(
			captureGithub({ ...env, GITHUB_ACCOUNT: "alice" }, {}),
			(error) => failureReason(error) === "github-stars-network",
		);
		globalThis.fetch = async (input) =>
			String(input).includes("/starred?")
				? Response.json([
						{
							starred_at: "2026-10-12T00:00:00Z",
							repo: {
								node_id: "readme-http-failure",
								full_name: "alice/demo",
								description: "Demo",
								topics: [],
								html_url: "https://github.com/alice/demo",
								pushed_at: "2026-10-12T00:00:00Z",
								created_at: "2026-01-01T00:00:00Z",
							},
						},
					])
				: new Response("private body", { status: 503 });
		await assert.rejects(
			captureGithub({ ...env, GITHUB_ACCOUNT: "alice" }, {}),
			(error) => failureReason(error) === "github-readme-http-503",
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("Instagram resume keeps the whole discovered backlog when a run has a smaller item budget", async () => {
	const urls = Array.from(
		{ length: 12 },
		(_, i) => `https://www.instagram.com/p/saved${i}/`,
	);
	const previous = crypto.randomUUID();
	await env.DB.prepare(
		"INSERT INTO jobs(id,source,status,state_json,result_json,created_at,updated_at) VALUES(?,'instagram','failed',?,'{}',?,?)",
	)
		.bind(
			previous,
			JSON.stringify({ urls, offset: 2, maxPages: 5, maxItems: 10 }),
			"2026-10-13T00:00:00Z",
			"2026-10-13T00:00:00Z",
		)
		.run();
	const job = await startJob(env, "instagram", { maxPages: 2, maxItems: 2 });
	const row = await env.DB.prepare("SELECT state_json FROM jobs WHERE id=?")
		.bind(job.id)
		.first<{ state_json: string }>();
	assert.ok(row);
	const state = JSON.parse(row.state_json);
	assert.equal(state.urls.length, 12);
	assert.equal(state.offset, 2);
	assert.equal(state.endOffset, 4);
});

test("Instagram session failures stay stopped until the owner confirms renewal", async () => {
	await env.DB.prepare("DELETE FROM jobs WHERE source='instagram'").run();
	const id = crypto.randomUUID();
	await env.DB.prepare(
		"INSERT INTO jobs(id,source,status,state_json,result_json,created_at,updated_at) VALUES(?,'instagram','failed','{}',?,?,?)",
	)
		.bind(
			id,
			JSON.stringify({
				failureDetail: {
					provider: "instagram",
					stage: "open-saved",
					reason: "challenge",
					sessionRenewalRequired: true,
				},
			}),
			"2026-10-13T01:00:00Z",
			"2026-10-13T01:00:00Z",
		)
		.run();
	const stopped = await startJob(env, "instagram");
	assert.equal(stopped.id, id);
	assert.equal(stopped.status, "failed");
	assert.equal(stopped.sessionRenewalRequired, true);
	const renewed = await startJob(
		env,
		"instagram",
		{ maxPages: 1, maxItems: 2 },
		true,
	);
	assert.notEqual(renewed.id, id);
	assert.equal(renewed.status, "queued");
});
