import { GithubRequestError } from "./source-errors";
import type { Env } from "./env";
import { indexBatch, storeDocument, type Document } from "./library";
import {
	captureX,
	captureInstagram,
	captureGithub,
	type SourceState,
} from "./sources";
export type JobSource = "x" | "instagram" | "github" | "index" | "import";
interface State extends SourceState {
	maxPages: number;
	maxItems: number;
}
interface Job {
	id: string;
	source: JobSource;
	status: string;
	state_json: string;
	result_json: string;
	attempts: number;
	lease_until: number;
}
export function failureReason(error: unknown) {
	if (error instanceof GithubRequestError)
		return `github-${error.operation}-${error.reason}${error.status ? `-${error.status}` : ""}`;
	const message = error instanceof Error ? error.message : "";
	if (/Browser time limit exceeded for today/i.test(message))
		return "browser-daily-budget";
	const status = message.match(
		/Unable to create new browser: code: (\d{3})/,
	)?.[1];
	if (status) return `browser-provider-${status}`;
	if (
		/account mismatch|signed in to a different Instagram account/.test(message)
	)
		return "source-account-mismatch";
	if (/Timeout|timeout|timed out/i.test(message)) {
		const operation = message.match(
			/(page\.goto|page\.waitForResponse|locator\.waitFor|locator\.click|page\.waitForURL)/,
		)?.[1];
		return operation ? `timeout:${operation}` : "provider-timeout";
	}
	if (/bookmark request failed|continuation failed/i.test(message))
		return "source-request-failed";
	if (/session missing|Invalid source session/.test(message))
		return "source-session-missing";
	return "provider-or-processing-error";
}
export async function startJob(
	env: Env,
	source: JobSource,
	limits = { maxPages: 5, maxItems: 10 },
) {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const previous = await env.DB.prepare(
		"SELECT id,status,state_json,result_json FROM jobs WHERE source=? AND status IN ('completed','failed') ORDER BY updated_at DESC LIMIT 1",
	)
		.bind(source)
		.first<Job>();
	const oldState = previous
		? (JSON.parse(previous.state_json) as State)
		: undefined;
	const oldResult = previous
		? (JSON.parse(previous.result_json) as Record<string, unknown>)
		: undefined;
	let state: State = { ...limits };
	let resumedFrom: string | undefined;
	if (
		source === "x" &&
		oldState?.cursor &&
		(oldResult?.partial || previous?.status === "failed")
	) {
		state = { ...limits, cursor: oldState.cursor, page: 0 };
		resumedFrom = previous?.id;
	} else if (
		source === "github" &&
		oldState?.page &&
		(oldResult?.warning === "Stopped at maxPages" ||
			previous?.status === "failed")
	) {
		state = {
			...limits,
			page: oldState.page,
			maxPages: oldState.page + limits.maxPages - 1,
		};
		resumedFrom = previous?.id;
	} else if (
		source === "instagram" &&
		previous?.status === "failed" &&
		oldState?.urls &&
		(oldState.offset ?? 0) < oldState.urls.length
	) {
		state = {
			...limits,
			urls: oldState.urls.slice(0, (oldState.offset ?? 0) + limits.maxItems),
			offset: oldState.offset,
		};
		resumedFrom = previous.id;
	}
	await env.DB.prepare(
		"INSERT OR IGNORE INTO jobs(id,source,status,state_json,result_json,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?)",
	)
		.bind(
			id,
			source,
			JSON.stringify(state),
			JSON.stringify(resumedFrom ? { resumedFrom } : {}),
			now,
			now,
		)
		.run();
	const job = await env.DB.prepare(
		"SELECT id,status FROM jobs WHERE source=? AND status IN ('queued','running','waiting-budget')",
	)
		.bind(source)
		.first<{ id: string; status: string }>();
	if (!job) throw new Error("Unable to create hydration job");
	let dispatchPending = false;
	if (job.status === "queued" && job.id === id)
		await env.JOBS.send({ jobId: job.id }).catch(() => {
			dispatchPending = true;
		});
	return { ...job, reused: job.id !== id, dispatchPending };
}
export async function queueImport(env: Env, documents: Document[]) {
	const payloads = documents.map((doc) => ({
		id: doc.id,
		payload: JSON.stringify(doc),
	}));
	if (
		payloads.some(
			(row) => new TextEncoder().encode(row.payload).byteLength > 1900000,
		)
	)
		throw new Error("Captured document exceeds the D1 payload limit");
	await env.DB.batch(
		payloads.map((row) =>
			env.DB.prepare(
				"INSERT INTO import_staging(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
			).bind(row.id, row.payload),
		),
	);
	return { accepted: documents.length, job: await startJob(env, "import") };
}
export async function jobStatus(env: Env, id: string) {
	const job = await env.DB.prepare(
		"SELECT id,source,status,result_json,created_at,updated_at,attempts FROM jobs WHERE id=?",
	)
		.bind(id)
		.first<{
			id: string;
			source: string;
			status: string;
			result_json: string;
			created_at: string;
			updated_at: string;
			attempts: number;
		}>();
	if (!job) return null;
	const { result_json, ...metadata } = job;
	return { ...metadata, result: JSON.parse(String(result_json)) };
}
export async function reserveBrowser(env: Env, now = Date.now()) {
	const day = new Date(now).toISOString().slice(0, 10);
	const max = Math.min(
		6,
		Math.max(1, Number(env.MAX_BROWSER_LAUNCHES_PER_DAY) || 6),
	);
	const row =
		await env.DB.prepare(`INSERT INTO browser_budget(day,launches,last_launch_at) VALUES(?,1,?)
	 ON CONFLICT(day) DO UPDATE SET launches=launches+1,last_launch_at=excluded.last_launch_at
	 WHERE launches<? AND last_launch_at<=? RETURNING launches`)
			.bind(day, now, max, now - 21000)
			.first();
	if (row) return "allowed";
	const usage = await env.DB.prepare(
		"SELECT launches FROM browser_budget WHERE day=?",
	)
		.bind(day)
		.first<{ launches: number }>();
	return (usage?.launches ?? 0) >= max ? "daily-budget" : "rate-limit";
}
export async function processMessage(
	env: Env,
	message: Message<{ jobId: string }>,
) {
	const owner = crypto.randomUUID();
	const now = Date.now();
	const job =
		await env.DB.prepare(`UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=?
	 WHERE id=? AND status IN ('queued','running') AND lease_until<=? RETURNING *`)
			.bind(
				owner,
				now + 120000,
				new Date(now).toISOString(),
				message.body.jobId,
				now,
			)
			.first<Job>();
	if (!job) {
		message.ack();
		return;
	}
	const save = async (
		status: string,
		state: State,
		result: Record<string, unknown>,
	) =>
		env.DB.prepare(
			"UPDATE jobs SET status=?,state_json=?,result_json=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_owner=?",
		)
			.bind(
				status,
				JSON.stringify(state),
				JSON.stringify(result),
				new Date().toISOString(),
				job.id,
				owner,
			)
			.run();
	const state = JSON.parse(job.state_json) as State;
	const result = JSON.parse(job.result_json) as Record<string, unknown>;
	try {
		if (job.source === "x" || job.source === "instagram") {
			const reservation = await reserveBrowser(env);
			if (reservation !== "allowed") {
				await save(
					reservation === "daily-budget" ? "waiting-budget" : "queued",
					state,
					{ ...result, warning: reservation },
				);
				if (reservation === "daily-budget") message.ack();
				else message.retry({ delaySeconds: 25 });
				return;
			}
		}
		let more: boolean;
		if (job.source === "import") {
			const rows = await env.DB.prepare(
				"SELECT id,payload FROM import_staging ORDER BY id LIMIT 5",
			).all<{ id: string; payload: string }>();
			let changed = false;
			for (const row of rows.results) {
				const stored = await storeDocument(
					env,
					JSON.parse(row.payload) as Document,
				);
				changed ||= stored.changed;
				await env.DB.prepare(
					"DELETE FROM import_staging WHERE id=? AND payload=?",
				)
					.bind(row.id, row.payload)
					.run();
			}
			result.imported = Number(result.imported ?? 0) + rows.results.length;
			more = rows.results.length === 5;
			if (changed) await startJob(env, "index");
		} else if (job.source === "index") {
			const indexed = await indexBatch(env);
			more = indexed.more;
			result.indexedPassages =
				Number(result.indexedPassages ?? 0) + indexed.count;
		} else {
			const capture =
				job.source === "x"
					? await captureX(env, state)
					: job.source === "instagram"
						? await captureInstagram(env, state, state.maxItems)
						: await captureGithub(env, state);
			const ids = JSON.stringify(capture.documents.map((doc) => doc.id));
			const known = await env.DB.prepare(
				"SELECT id FROM documents WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT id FROM import_staging WHERE id IN (SELECT value FROM json_each(?))",
			)
				.bind(ids, ids)
				.all<{ id: string }>();
			const allKnown =
				capture.documents.length > 0 &&
				known.results.length === capture.documents.length;
			if (capture.documents.length)
				result.importJob = (await queueImport(env, capture.documents)).job.id;
			Object.assign(state, capture.state);
			result.captured = Number(result.captured ?? 0) + capture.documents.length;
			result.accepted = Number(result.accepted ?? 0) + capture.documents.length;
			result.partial = Boolean(result.partial) || capture.partial;
			result.warnings = [
				...(Array.isArray(result.warnings) ? result.warnings : []),
				...capture.warnings,
			].slice(-20);
			more = capture.more;
			if (job.source === "x" && allKnown) {
				more = false;
				result.caughtUp = true;
			}
			if (
				job.source !== "instagram" &&
				(state.page ?? 0) >=
					(job.source === "github" ? state.maxPages + 1 : state.maxPages) &&
				more
			) {
				more = false;
				result.partial = true;
				result.warning = "Stopped at maxPages";
			}
		}
		await save(more ? "queued" : "completed", state, result);
		if (more)
			await env.JOBS.send(
				{ jobId: job.id },
				{
					delaySeconds:
						job.source === "index" || job.source === "import" ? 0 : 25,
				},
			);
		message.ack();
	} catch (error) {
		if (failureReason(error) === "browser-daily-budget") {
			await save("waiting-budget", state, {
				...result,
				failureReason: "browser-daily-budget",
			});
			message.ack();
			return;
		}
		const permanent = [
			"source-account-mismatch",
			"source-session-missing",
		].includes(failureReason(error));
		await save(
			permanent || message.attempts >= 3 ? "failed" : "queued",
			state,
			{
				...result,
				failureReason: failureReason(error),
				...(error instanceof GithubRequestError
					? { failureDetail: error.diagnostic() }
					: {}),
				partial: true,
				error:
					"Source or index step failed; existing archive retained. Check session expiry and free quotas.",
			},
		);
		if (permanent || message.attempts >= 3) message.ack();
		else message.retry({ delaySeconds: 60 });
	}
}
export async function recoverJobs(env: Env) {
	if (await env.DB.prepare("SELECT id FROM import_staging LIMIT 1").first())
		await startJob(env, "import");
	if (
		await env.DB.prepare(
			"SELECT id FROM passages WHERE indexed_hash IS NULL LIMIT 1",
		).first()
	)
		await startJob(env, "index");
	const today = new Date().toISOString().slice(0, 10);
	await env.DB.prepare(
		"UPDATE jobs SET status='queued',lease_until=0,lease_owner=NULL WHERE (status='running' AND lease_until<=?) OR (status='waiting-budget' AND substr(updated_at,1,10)<?)",
	)
		.bind(Date.now(), today)
		.run();
	const jobs = await env.DB.prepare(
		"SELECT id FROM jobs WHERE status='queued' AND updated_at<? LIMIT 10",
	)
		.bind(new Date(Date.now() - 300000).toISOString())
		.all<{ id: string }>();
	await Promise.all(
		jobs.results.map((job) => env.JOBS.send({ jobId: job.id })),
	);
}
