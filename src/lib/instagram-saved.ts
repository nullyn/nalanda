import { instagramPath, verifyInstagramAccount } from "./instagram-account";
import { readStandalonePostDom } from "./instagram-post-dom";
export { readStandalonePostDom } from "./instagram-post-dom";
import { createHash } from "node:crypto";
import { getCookies } from "@steipete/sweet-cookie";
import type { BrowserContext, Page } from "playwright";
import { getBirdclawConfig } from "./config";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { getSavedResource, upsertSavedResource } from "./saved-resources";
import { launchSavedBrowser } from "./saved-browser";

export interface SyncInstagramCollectionOptions {
	username: string;
	collection?: string;
	maxItems?: number;
	chromeProfile?: string;
}

export interface InstagramCollectionSyncResult {
	account: string;
	count: number;
	newCount: number;
	updatedCount: number;
	partial: boolean;
	warnings: string[];
}

function normalizedText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function captionQuality(source: unknown) {
	if (source === "visible-caption" || source === "visible-caption-span")
		return 3;
	if (source === "metadata-caption") return 2;
	if (source === "grid-image-alt-preview" || source === "metadata-preview")
		return 1;
	return 0;
}

function storedStrings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string => typeof item === "string" && Boolean(item),
			)
		: [];
}

async function visibleCollectionLink(
	page: Page,
	username: string,
	collection: string,
) {
	const candidates = page.getByRole("link", { name: collection, exact: true });
	await candidates
		.first()
		.waitFor({ state: "visible", timeout: 15_000 })
		.catch(() => undefined);
	const count = await candidates.count();
	for (let index = 0; index < count; index += 1) {
		const candidate = candidates.nth(index);
		if (!(await candidate.isVisible().catch(() => false))) continue;
		const href = await candidate.getAttribute("href");
		const path = href
			? instagramPath(new URL(href, "https://www.instagram.com").href)
			: null;
		const segments = path?.split("/").filter(Boolean) ?? [];
		if (
			segments.length === 4 &&
			segments[0]?.toLowerCase() === username.toLowerCase() &&
			segments[1] === "saved"
		)
			return href;
	}
	return null;
}

async function collectPermalinks(
	page: Page,
	maxItems: number,
	warnings: string[],
) {
	const urls = new Map<string, string>();
	let stalled = 0;
	while (urls.size < maxItems && stalled < 4) {
		const before = urls.size;
		const anchors = page.locator('a[href*="/p/"], a[href*="/reel/"]');
		const count = await anchors.count();
		for (let index = 0; index < count && urls.size < maxItems; index += 1) {
			const anchor = anchors.nth(index);
			const href = await anchor.getAttribute("href");
			if (!href) continue;
			const absolute = new URL(href, "https://www.instagram.com");
			if (absolute.hostname !== "www.instagram.com") continue;
			const match = absolute.pathname.match(
				/^\/(?:[^/]+\/)?(?:p|reel)\/([^/]+)\/?$/,
			);
			if (!match) continue;
			const imageAlt = await anchor
				.locator("img")
				.first()
				.getAttribute("alt")
				.catch(() => null);
			urls.set(absolute.origin + absolute.pathname, normalizedText(imageAlt));
		}
		if (urls.size >= maxItems) break;
		if (urls.size === before) stalled += 1;
		else stalled = 0;
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await page.waitForTimeout(900);
	}
	if (urls.size >= maxItems)
		warnings.push(
			`Stopped at the maxItems limit (${maxItems}); later collection posts were not read.`,
		);
	else if (stalled >= 4)
		warnings.push(
			"Instagram stopped loading more saved posts after scrolling.",
		);
	return [...urls]
		.slice(0, maxItems)
		.map(([url, preview]) => ({ url, preview }));
}

function parsePostRoute(url: string) {
	const parsed = new URL(url);
	if (parsed.hostname !== "www.instagram.com") return null;
	const match = parsed.pathname.match(/^\/(?:([^/]+)\/)?(p|reel)\/([^/]+)\/?$/);
	if (!match?.[2] || !match[3]) return null;
	return {
		authorFromPath: match[1] ?? "",
		shortcode: match[3],
		url: `https://www.instagram.com${parsed.pathname}`,
	};
}

function captionFromMetadata(value: string): string {
	const match = value.match(/:\s*["“]([\s\S]*)[”"]\s*$/u);
	return normalizedText(match?.[1]);
}

function explicitUrls(value: string): string[] {
	return [...value.matchAll(/https?:\/\/[^\s<>()]+/g)]
		.map((match) => match[0]?.replace(/[.,!?;:)]+$/, ""))
		.filter((url): url is string => Boolean(url));
}

export function dateFromMetadata(value: string): string {
	const date = value.match(/\bon ([A-Z][a-z]+ \d{1,2}, \d{4})\b/);
	if (!date?.[1]) return "";
	const parsed = new Date(`${date[1]} UTC`);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString().slice(0, 10)
		: "";
}

async function readStandalonePostText(page: Page, targetAuthor: string) {
	return page.evaluate(readStandalonePostDom, {
		author: targetAuthor,
		origin: "https://www.instagram.com",
	});
}

async function readPost(
	context: BrowserContext,
	url: string,
	gridPreview: string,
) {
	const page = await context.newPage();
	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		const canonicalNode = page.locator('meta[property="og:url"]');
		const canonicalUrl = (await canonicalNode.count())
			? await canonicalNode.getAttribute("content").catch(() => null)
			: null;
		const requestedRoute = parsePostRoute(url);
		const canonicalRoute = parsePostRoute(canonicalUrl || page.url());
		const route =
			canonicalRoute && requestedRoute
				? {
						...canonicalRoute,
						authorFromPath:
							canonicalRoute.authorFromPath || requestedRoute.authorFromPath,
						url: requestedRoute.url,
					}
				: (canonicalRoute ?? requestedRoute);
		if (!route) return null;
		const article = page.locator("article").first();
		const heading = article.locator("h1").first();
		const captionMetadata = page.locator('meta[property="og:description"]');
		await Promise.race([
			heading
				.waitFor({ state: "visible", timeout: 5_000 })
				.then(() => "article")
				.catch(() => null),
			page
				.locator("main time[datetime]")
				.first()
				.waitFor({ state: "visible", timeout: 5_000 })
				.then(() => "standalone")
				.catch(() => null),
		]);
		const articleVisible = await article.isVisible().catch(() => false);
		if (articleVisible) {
			await heading
				.waitFor({ state: "visible", timeout: 2_000 })
				.catch(() => undefined);
		}
		const visibleCaption = normalizedText(
			(await heading.count()) ? await heading.innerText().catch(() => "") : "",
		);
		const metadataPreview = normalizedText(
			(await captionMetadata.count())
				? await captionMetadata.getAttribute("content").catch(() => null)
				: null,
		);
		const metadataCaption = captionFromMetadata(metadataPreview);
		const standalone = articleVisible
			? { caption: "", publishedAt: "", comments: [], links: [] }
			: await readStandalonePostText(page, route.authorFromPath);
		const caption =
			visibleCaption ||
			standalone.caption ||
			metadataCaption ||
			gridPreview ||
			metadataPreview;
		if (!articleVisible && !caption) return null;
		const authorLink = article
			.locator('a[href^="/"]')
			.filter({ hasText: /^@?\w[\w.]*$/ })
			.first();
		let author = normalizedText(
			(await authorLink.count())
				? await authorLink.innerText().catch(() => "")
				: "",
		).replace(/^@/, "");
		if (!author && (await authorLink.count())) {
			const authorHref = await authorLink
				.getAttribute("href")
				.catch(() => null);
			author =
				authorHref?.split("/").filter(Boolean)[0] ?? route.authorFromPath;
		}
		if (!author) author = route.authorFromPath;
		const time = article.locator("time[datetime]").first();
		const publishedAt = (await time.count())
			? await time.getAttribute("datetime").catch(() => null)
			: standalone.publishedAt || null;
		const publishedDate = dateFromMetadata(metadataPreview);
		const captionSource = visibleCaption
			? "visible-caption"
			: standalone.caption
				? "visible-caption-span"
				: metadataCaption
					? "metadata-caption"
					: gridPreview
						? "grid-image-alt-preview"
						: metadataPreview
							? "metadata-preview"
							: "unavailable";
		const authorDetails = articleVisible
			? await article.evaluate((root, targetAuthor) => {
					const target = targetAuthor.toLowerCase();
					const commentFilter = {
						isCommentText(value: string) {
							const text = value.replace(/\s+/g, " ").trim();
							return Boolean(
								text &&
								text.replace(/^@/, "").toLowerCase() !== target &&
								!/^\d+\s*(?:s|m|h|d|w|sec(?:ond)?s?|min(?:ute)?s?|hours?|days?|weeks?)(?:\s+ago)?$/i.test(
									text,
								) &&
								!/^(?:reply|like|view all\b|view replies\b)/i.test(text),
							);
						},
					};
					const comments: string[] = [];
					const links = new Set<string>();
					const identity = {
						handleFor(anchor: HTMLAnchorElement) {
							return anchor
								.getAttribute("href")
								?.split("/")
								.filter(Boolean)[0]
								?.toLowerCase();
						},
					};
					const linkCollector = {
						addTextLinks(node: Element) {
							for (const anchor of node.querySelectorAll<HTMLAnchorElement>(
								"a[href]",
							)) {
								try {
									const url = new URL(anchor.href, window.location.origin);
									if (
										(url.protocol === "http:" || url.protocol === "https:") &&
										url.hostname !== "www.instagram.com" &&
										url.hostname !== "instagram.com"
									)
										links.add(url.href);
								} catch {
									// Ignore malformed or non-web links.
								}
							}
							for (const match of node.textContent?.matchAll(
								/https?:\/\/[^\s<>()]+/g,
							) ?? []) {
								const value = match[0]?.replace(/[.,!?;:)]+$/, "");
								if (value) links.add(value);
							}
						},
					};
					const captionNode = root.querySelector("h1");
					if (captionNode) linkCollector.addTextLinks(captionNode);
					for (const row of root.querySelectorAll("li")) {
						if (row.querySelector("h1")) continue;
						const commentHeading = row.querySelector("h3");
						const commentAuthor =
							commentHeading?.querySelector<HTMLAnchorElement>('a[href^="/"]');
						if (
							!commentAuthor ||
							commentAuthor.closest("li") !== row ||
							identity.handleFor(commentAuthor) !== target
						)
							continue;
						const textNodes = Array.from(
							row.querySelectorAll<HTMLElement>('span[dir="auto"]'),
						).filter((node) => node.closest("li") === row);
						const text = textNodes
							.map((node) => node.innerText.replace(/\s+/g, " ").trim())
							.filter(commentFilter.isCommentText)
							.join(" ")
							.trim();
						if (
							text &&
							text !== captionNode?.textContent?.replace(/\s+/g, " ").trim()
						)
							comments.push(text);
						for (const node of textNodes) linkCollector.addTextLinks(node);
					}
					return { comments: [...new Set(comments)], links: [...links] };
				}, author)
			: standalone;
		const authorLinks = [
			...new Set([...authorDetails.links, ...explicitUrls(caption)]),
		];
		return {
			shortcode: route.shortcode,
			url: route.url,
			author,
			caption,
			captionSource,
			authorComments: authorDetails.comments,
			authorLinks,
			publishedAt: publishedAt || publishedDate,
			publishedAtSource: publishedAt
				? "time-element"
				: publishedDate
					? "metadata-date-only"
					: "unavailable",
		};
	} finally {
		await page.close();
	}
}

async function syncInstagramCollectionPromise(
	options: SyncInstagramCollectionOptions,
): Promise<InstagramCollectionSyncResult> {
	const username = options.username.trim().replace(/^@/, "").toLowerCase();
	const collection = options.collection?.trim() || "AI";
	const maxItems = options.maxItems ?? 500;
	if (
		!/^[A-Za-z0-9._]{1,30}$/.test(username) ||
		!Number.isInteger(maxItems) ||
		maxItems < 1
	)
		throw new Error("username and a positive integer maxItems are required.");
	const { cookies } = await getCookies({
		url: "https://www.instagram.com/",
		browsers: ["chrome"],
		chromiumBrowser: "chrome",
		mode: "first",
		chromeProfile:
			options.chromeProfile ??
			process.env.BIRDCLAW_CHROME_PROFILE ??
			getBirdclawConfig().bookmarks?.chromeProfile,
		names: ["sessionid", "ds_user_id", "csrftoken"],
		timeoutMs: 30_000,
	});
	if (!cookies.some((cookie) => cookie.name === "sessionid"))
		throw new Error(
			"No Instagram session found in Chrome. Sign in to Instagram in Chrome first.",
		);
	const browser = await launchSavedBrowser();
	try {
		const context = await browser.newContext();
		await context.addCookies(
			cookies.map((cookie) => ({
				name: cookie.name,
				value: cookie.value,
				domain: ".instagram.com",
				path: "/",
				secure: true,
				httpOnly: cookie.httpOnly ?? false,
				...(cookie.sameSite
					? { sameSite: cookie.sameSite as "Strict" | "Lax" | "None" }
					: {}),
			})),
		);
		const page = await context.newPage();
		await page.goto(
			`https://www.instagram.com/${encodeURIComponent(username)}/saved/`,
			{ waitUntil: "domcontentloaded", timeout: 30_000 },
		);
		await verifyInstagramAccount(page, username);
		const collectionHref = await visibleCollectionLink(
			page,
			username,
			collection,
		);
		if (!collectionHref)
			throw new Error(
				`Could not find the visible “${collection}” saved collection for @${username}.`,
			);
		await page.goto(new URL(collectionHref, "https://www.instagram.com").href, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		const path = instagramPath(page.url())?.split("/").filter(Boolean) ?? [];
		if (
			path[0]?.toLowerCase() !== username.toLowerCase() ||
			path[1] !== "saved" ||
			path.length !== 4
		)
			throw new Error("Instagram did not open the selected saved collection.");
		const warnings: string[] = [];
		const permalinks = await collectPermalinks(page, maxItems, warnings);
		let newCount = 0;
		let updatedCount = 0;
		let count = 0;
		for (const permalink of permalinks) {
			const post = await readPost(
				context,
				permalink.url,
				permalink.preview,
			).catch(() => null);
			if (!post?.shortcode) {
				warnings.push(`Could not read saved post ${permalink.url}.`);
				continue;
			}
			const existing = await getSavedResource(
				"instagram",
				username,
				post.shortcode,
			);
			const prior = existing?.metadata;
			if (
				typeof prior?.caption === "string" &&
				prior.caption &&
				captionQuality(prior.captionSource) > captionQuality(post.captionSource)
			) {
				post.caption = prior.caption;
				post.captionSource = String(prior.captionSource);
				warnings.push(
					`Kept the previously captured caption for ${post.url}; this fetch only supplied a preview.`,
				);
			}
			if (
				typeof prior?.publishedAt === "string" &&
				prior.publishedAt &&
				(!post.publishedAt ||
					(prior.publishedAtSource === "time-element" &&
						post.publishedAtSource !== "time-element"))
			) {
				post.publishedAt = prior.publishedAt;
				post.publishedAtSource = String(
					prior.publishedAtSource ?? "unavailable",
				);
			}
			if (!post.author && existing?.author) post.author = existing.author;
			post.authorComments = [
				...new Set([
					...storedStrings(prior?.authorComments),
					...post.authorComments,
				]),
			];
			post.authorLinks = [
				...new Set([...storedStrings(prior?.authorLinks), ...post.authorLinks]),
			];
			const text = [post.caption, ...post.authorComments]
				.filter(Boolean)
				.join("\n\n");
			const contentHash = hash(
				[
					post.url,
					post.author,
					text,
					post.publishedAt,
					...post.authorComments,
					...post.authorLinks,
				].join("\n"),
			);
			const fetchedAt = new Date().toISOString();
			const storedFirstSeen = existing?.metadata.firstSeenAt;
			const firstSeenAt =
				typeof storedFirstSeen === "string"
					? storedFirstSeen
					: (existing?.savedAt ?? fetchedAt);
			await upsertSavedResource({
				source: "instagram",
				account: username,
				externalId: post.shortcode,
				url: post.url,
				title: text.slice(0, 180),
				author: post.author,
				text,
				savedAt: existing?.savedAt ?? firstSeenAt,
				fetchedAt,
				metadata: {
					...existing?.metadata,
					collection,
					firstSeenAt,
					savedAtSource: "first-seen",
					caption: post.caption,
					captionSource: post.captionSource,
					authorComments: post.authorComments,
					authorCommentsSource: "initially-loaded-post-dom",
					authorCommentsComplete: false,
					authorLinks: post.authorLinks,
					publishedAt: post.publishedAt,
					publishedAtSource: post.publishedAtSource,
					preview: post.caption.slice(0, 500),
					previewOnly: !["visible-caption", "visible-caption-span"].includes(
						post.captionSource,
					),
				},
				contentHash,
			});
			count += 1;
			if (!existing) newCount += 1;
			else if (existing.contentHash !== contentHash) updatedCount += 1;
		}
		return {
			account: username,
			count,
			newCount,
			updatedCount,
			partial: warnings.length > 0 || permalinks.length >= maxItems,
			warnings,
		};
	} finally {
		await browser.close();
	}
}

export function syncInstagramCollectionEffect(
	options: SyncInstagramCollectionOptions,
) {
	return tryPromise(() => syncInstagramCollectionPromise(options));
}

export function syncInstagramCollection(
	options: SyncInstagramCollectionOptions,
): Promise<InstagramCollectionSyncResult> {
	return runEffectPromise(syncInstagramCollectionEffect(options));
}
