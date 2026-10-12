import { verifyInstagramAccount } from "../../src/lib/instagram-account";
import { GithubRequestError } from "./source-errors";
import { parseBrowserBookmarks } from "../../src/lib/bookmarks-parser";
import { readStandalonePostDom } from "../../src/lib/instagram-post-dom";
import type { Env } from "./env";
import { readDocument, type Document } from "./library";

export interface SourceState {
	cursor?: string;
	urls?: string[];
	page?: number;
	offset?: number;
}
export interface Capture {
	documents: Document[];
	state: SourceState;
	more: boolean;
	partial: boolean;
	warnings: string[];
}
function identity(source: string, account: string, id: string) {
	return JSON.stringify([source, account, id]);
}
function handle(value: string) {
	if (!/^[a-zA-Z0-9_.-]{1,39}$/.test(value))
		throw new Error("Source account is not configured");
	return value.toLowerCase();
}
async function withBrowser<T>(
	env: Env,
	source: "x" | "instagram",
	action: (
		page: import("@cloudflare/playwright").Page,
		context: import("@cloudflare/playwright").BrowserContext,
	) => Promise<T>,
) {
	const session =
		source === "x" ? env.X_SESSION_COOKIES : env.INSTAGRAM_SESSION_COOKIES;
	if (!session) throw new Error("Source session missing");
	const cookies = JSON.parse(session) as Array<{
		name: string;
		value: string;
		httpOnly?: boolean;
	}>;
	const allowed =
		source === "x"
			? ["auth_token", "ct0"]
			: ["sessionid", "ds_user_id", "csrftoken"];
	if (
		!Array.isArray(cookies) ||
		!cookies.some(
			(c) => c.name === allowed[0] && typeof c.value === "string" && c.value,
		)
	)
		throw new Error("Invalid source session");
	const { launch } = await import("@cloudflare/playwright");
	const browser = await launch(env.BROWSER, {
		keep_alive: 10000,
		recording: false,
	});
	const deadline = setTimeout(() => {
		void browser.close();
	}, 45000);
	try {
		const context = await browser.newContext();
		await context.addCookies(
			cookies
				.filter((c) => allowed.includes(c.name))
				.map((c) => ({
					...c,
					domain: source === "x" ? ".x.com" : ".instagram.com",
					path: "/",
					secure: true,
					httpOnly: c.httpOnly ?? ["auth_token", "sessionid"].includes(c.name),
				})),
		);
		await context.route("**/*", (route) =>
			["image", "media", "font"].includes(route.request().resourceType())
				? route.abort()
				: route.continue(),
		);
		const page = await context.newPage();
		page.setDefaultTimeout(10000);
		return await action(page, context);
	} finally {
		clearTimeout(deadline);
		await browser.close();
	}
}
export async function captureX(env: Env, state: SourceState): Promise<Capture> {
	const username = handle(env.X_ACCOUNT);
	return withBrowser(env, "x", async (page) => {
		const pending = page.waitForResponse(
			(r) =>
				new URL(r.url()).hostname === "x.com" &&
				/\/graphql\/[^/]+\/Bookmarks(?:\?|$)/.test(r.url()),
			{ timeout: 20000 },
		);
		void pending.catch(() => undefined);
		await page.goto("https://x.com/i/bookmarks", {
			waitUntil: "domcontentloaded",
			timeout: 20000,
		});
		const profile = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
		await profile.waitFor();
		if (
			(await profile.getAttribute("href"))?.replace(/^\//, "").toLowerCase() !==
			username
		)
			throw new Error("X account mismatch");
		const response = await pending;
		if (!response.ok()) throw new Error("X bookmark request failed");
		let raw: unknown = await response.json();
		if (state.cursor) {
			const url = new URL(response.url());
			const variables = JSON.parse(url.searchParams.get("variables") ?? "{}");
			variables.cursor = state.cursor;
			url.searchParams.set("variables", JSON.stringify(variables));
			const original = await response.request().allHeaders();
			const headers = Object.fromEntries(
				[
					"authorization",
					"x-csrf-token",
					"x-twitter-active-user",
					"x-twitter-auth-type",
				]
					.filter((k) => original[k])
					.map((k) => [k, original[k]!]),
			);
			raw = await page.evaluate(
				async ({ url, headers }) => {
					const result = await fetch(url, { headers, credentials: "include" });
					if (!result.ok) throw new Error("Bookmark continuation failed");
					return result.json();
				},
				{ url: url.href, headers },
			);
		}
		const parsed = parseBrowserBookmarks(raw);
		const account = `acct_${username}`;
		const users = new Map(parsed.includes?.users?.map((u) => [u.id, u]));
		const context = new Map(parsed.includes?.tweets?.map((t) => [t.id, t]));
		const now = new Date().toISOString();
		const documents: Document[] = parsed.data.map((t) => {
			const user = users.get(t.author_id);
			const quote = context.get(
				t.referenced_tweets?.find((r) => r.type === "quoted")?.id ?? "",
			)?.text;
			const urls =
				(
					t.entities as {
						urls?: Array<{
							expanded_url?: string;
							title?: string;
							description?: string;
						}>;
					}
				)?.urls ?? [];
			const text = [
				t.text,
				quote ? `Quoted post: ${quote}` : "",
				...urls.map((u) =>
					[u.title, u.description, u.expanded_url].filter(Boolean).join("\n"),
				),
			]
				.filter(Boolean)
				.join("\n\n");
			return {
				id: identity("x", account, t.id),
				source: "x",
				account,
				externalId: t.id,
				url: `https://x.com/${user?.username ?? "i/web"}/status/${t.id}`,
				title: t.text.slice(0, 180),
				author: user?.name ?? "",
				text,
				publishedAt: t.created_at,
				publishedAtSource: "tweet.created_at",
				savedAt: null,
				savedAtSource: null,
				fetchedAt: now,
			};
		});
		const cursor =
			typeof parsed.meta?.next_token === "string"
				? parsed.meta.next_token
				: undefined;
		if (parsed.data.length && cursor && cursor === state.cursor)
			throw new Error("X repeated its cursor");
		return {
			documents,
			state: { cursor, page: (state.page ?? 0) + 1 },
			more: parsed.data.length > 0 && Boolean(cursor),
			partial: false,
			warnings: [],
		};
	});
}
export async function captureInstagram(
	env: Env,
	state: SourceState,
	maxItems: number,
): Promise<Capture> {
	const account = handle(env.INSTAGRAM_ACCOUNT);
	return withBrowser(env, "instagram", async (page, context) => {
		await page.goto(`https://www.instagram.com/${account}/saved/`, {
			waitUntil: "domcontentloaded",
			timeout: 20000,
		});
		await verifyInstagramAccount(page, account);
		let urls = state.urls;
		if (!urls) {
			await page
				.getByText(env.INSTAGRAM_COLLECTION, { exact: true })
				.first()
				.click();
			await page.waitForURL(new RegExp(`/${account}/saved/[^/]+/[^/]+/`));
			await page.locator('a[href*="/p/"],a[href*="/reel/"]').first().waitFor();
			urls = [
				...new Set(
					await page
						.locator('a[href*="/p/"],a[href*="/reel/"]')
						.evaluateAll((links) =>
							links.map((link) => (link as HTMLAnchorElement).href),
						),
				),
			]
				.filter((url) => {
					const u = new URL(url);
					return (
						u.hostname === "www.instagram.com" &&
						/^\/(?:[^/]+\/)?(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)
					);
				})
				.slice(0, maxItems);
		}
		const documents: Document[] = [];
		const warnings: string[] = [];
		const offset = state.offset ?? 0;
		for (const url of urls.slice(offset, offset + 2)) {
			const post = await context.newPage();
			try {
				await post.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
				await post
					.locator("main time[datetime],article h1")
					.first()
					.waitFor({ timeout: 5000 })
					.catch(() => undefined);
				const metadata =
					(await post
						.locator('meta[property="og:description"]')
						.getAttribute("content")
						.catch(() => null)) ?? "";
				const author = await post
					.locator('main a[href^="/"]')
					.evaluateAll(
						(links) =>
							links
								.map((link) =>
									link.getAttribute("href")?.split("/").filter(Boolean),
								)
								.find(
									(parts) =>
										parts?.length === 1 &&
										!["explore", "accounts", "reels"].includes(parts[0]!),
								)?.[0] ?? "",
					);
				const extracted = await post.evaluate(readStandalonePostDom, {
					author,
					origin: "https://www.instagram.com",
				});
				const caption =
					extracted.caption ||
					metadata.match(/:\s*["“]([\s\S]*)[”"]\s*$/u)?.[1] ||
					"";
				if (!caption) {
					warnings.push("A post did not supply a readable caption");
					continue;
				}
				const externalId = new URL(url).pathname
					.split("/")
					.filter(Boolean)
					.at(-1)!;
				const now = new Date().toISOString();
				const existing = await readDocument(
					env,
					identity("instagram", account, externalId),
				);
				const old = existing?.metadata;
				const visible = Boolean(extracted.caption);
				const finalCaption =
					!visible && old?.captionSource === "visible-caption-span"
						? String(old.caption)
						: caption;
				const links = [
					...new Set([
						...(Array.isArray(old?.authorLinks)
							? (old.authorLinks as string[])
							: []),
						...extracted.links,
					]),
				];
				const comments = [
					...new Set([
						...(Array.isArray(old?.authorComments)
							? old.authorComments.filter(
									(v): v is string => typeof v === "string",
								)
							: []),
						...extracted.comments,
					]),
				];
				const text = [
					finalCaption,
					...comments,
					links.length ? `Author links: ${links.join("\n")}` : "",
				]
					.filter(Boolean)
					.join("\n\n");
				documents.push({
					id: identity("instagram", account, externalId),
					source: "instagram",
					account,
					externalId,
					url,
					title: text.slice(0, 180),
					author,
					text,
					publishedAt: extracted.publishedAt || existing?.publishedAt || null,
					publishedAtSource: extracted.publishedAt
						? "time-element"
						: (existing?.publishedAtSource ?? null),
					savedAt: existing?.savedAt ?? now,
					savedAtSource: existing?.savedAtSource ?? "first-seen",
					fetchedAt: now,
					metadata: {
						...old,
						collection: env.INSTAGRAM_COLLECTION,
						caption: finalCaption,
						captionSource: visible
							? "visible-caption-span"
							: (old?.captionSource ?? "metadata-caption"),
						authorComments: comments,
						authorLinks: links,
						authorCommentsComplete: false,
					},
				});
			} finally {
				await post.close();
			}
		}
		const next = offset + 2;
		return {
			documents,
			state: { urls, offset: next },
			more: next < urls.length,
			partial: true,
			warnings,
		};
	});
}
async function githubFetch(path: string, operation: "stars" | "readme") {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/${path}`, {
			headers: {
				Accept:
					operation === "stars"
						? "application/vnd.github.star+json"
						: "application/vnd.github.raw+json",
				"User-Agent": "Nalanda",
			},
			signal: AbortSignal.timeout(15000),
		});
	} catch (error) {
		throw new GithubRequestError(
			operation,
			error instanceof Error &&
				["TimeoutError", "AbortError"].includes(error.name)
				? "timeout"
				: "network",
		);
	}
	if (!response.ok && !(operation === "readme" && response.status === 404))
		throw GithubRequestError.fromResponse(operation, response);
	return response;
}
async function githubJson(path: string) {
	const response = await githubFetch(path, "stars");
	try {
		return await response.json();
	} catch {
		throw new GithubRequestError("stars", "invalid-response");
	}
}

async function boundedReadme(response: Response): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 1048576) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
export async function captureGithub(
	env: Env,
	state: SourceState,
): Promise<Capture> {
	const account = handle(env.GITHUB_ACCOUNT);
	const page = state.page ?? 1;
	const stars = (await githubJson(
		`users/${account}/starred?per_page=5&page=${page}`,
	)) as Array<{
		starred_at: string;
		repo: {
			node_id: string;
			full_name: string;
			description: string | null;
			topics: string[];
			html_url: string;
			pushed_at: string;
			created_at: string;
		};
	}>;
	if (!Array.isArray(stars))
		throw new GithubRequestError("stars", "invalid-response");
	const documents: Document[] = [];
	const warnings: string[] = [];
	for (const { repo, starred_at } of stars) {
		const id = identity("github", account, repo.node_id);
		const old = await readDocument(env, id);
		let readme =
			typeof old?.metadata?.readmeStart === "number"
				? old.text.slice(old.metadata.readmeStart)
				: String(old?.metadata?.readme ?? "");
		let readmeWarning =
			typeof old?.metadata?.readmeWarning === "string"
				? old.metadata.readmeWarning
				: null;
		if (!old || old.metadata?.pushedAt !== repo.pushed_at || !readme) {
			readmeWarning = null;
			const response = await githubFetch(
				`repos/${repo.full_name}/readme`,
				"readme",
			);
			if (response.ok) {
				const captured = await boundedReadme(response);
				if (captured === null)
					readmeWarning = `README exceeds 1 MiB for ${repo.full_name}; prior captured README retained when available`;
				else readme = captured;
			} else readmeWarning = `README unavailable for ${repo.full_name}`;
		}
		if (readmeWarning) warnings.push(readmeWarning);
		const prefix = [
			repo.description,
			repo.topics?.length ? `Topics: ${repo.topics.join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		const text = [prefix, readme].filter(Boolean).join("\n\n");
		documents.push({
			id,
			source: "github",
			account,
			externalId: repo.node_id,
			url: repo.html_url,
			title: repo.full_name,
			author: repo.full_name.split("/")[0]!,
			text,
			publishedAt: repo.created_at,
			publishedAtSource: "repository.created_at",
			savedAt: starred_at,
			savedAtSource: "starred-at",
			fetchedAt: new Date().toISOString(),
			metadata: {
				readmeStart: readme ? text.length - readme.length : text.length,
				pushedAt: repo.pushed_at,
				readmeWarning,
				topics: repo.topics,
			},
		});
	}
	return {
		documents,
		state: { page: page + 1 },
		more: stars.length === 5,
		partial: warnings.length > 0,
		warnings,
	};
}
