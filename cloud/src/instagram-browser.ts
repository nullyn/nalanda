import type { Page, Locator } from "@cloudflare/playwright";
import { InstagramCaptureError, type InstagramStage } from "./source-errors";

type InstagramLocator = Pick<
	Locator,
	"isVisible" | "waitFor" | "count" | "evaluate" | "evaluateAll"
> & {
	first(): InstagramLocator;
	nth(index: number): InstagramLocator;
};
type InstagramPage = Pick<Page, "url" | "waitForTimeout" | "evaluate"> & {
	locator(selector: string): InstagramLocator;
	getByText(...args: Parameters<Page["getByText"]>): InstagramLocator;
};

export async function checkInstagramSession(
	page: InstagramPage,
	stage: InstagramStage,
) {
	const path = new URL(page.url()).pathname;
	if (/\/(challenge|checkpoint)(\/|$)/.test(path))
		throw new InstagramCaptureError(stage, "challenge");
	if (
		/\/accounts\/login(\/|$)/.test(path) ||
		(await page
			.locator('input[type="password"],input[name="password"]')
			.first()
			.isVisible()
			.catch(() => false))
	)
		throw new InstagramCaptureError(stage, "session-required");
}
export async function instagramStep<T>(
	page: InstagramPage,
	stage: InstagramStage,
	action: () => Promise<T>,
) {
	try {
		await checkInstagramSession(page, stage);
		const value = await action();
		await checkInstagramSession(page, stage);
		return value;
	} catch (error) {
		if (error instanceof InstagramCaptureError) throw error;
		await checkInstagramSession(page, stage);
		const message = error instanceof Error ? error.message : "";
		const signals = await page
			.evaluate(() => ({
				profileImages: document.querySelectorAll(
					'a img[alt*="profile picture" i]',
				).length,
				loginLinks: document.querySelectorAll('a[href*="/accounts/login"]')
					.length,
				passwordFields: document.querySelectorAll('input[type="password"]')
					.length,
				links: document.querySelectorAll("a[href]").length,
			}))
			.catch(() => undefined);
		throw new InstagramCaptureError(
			stage,
			/signed in to a different Instagram account|account mismatch/i.test(
				message,
			)
				? "account-mismatch"
				: /Timeout|timed out/i.test(message)
					? "ui-timeout"
					: "browser-step-failed",
			signals,
		);
	}
}
function collectionHref(href: string | null, account: string) {
	if (!href) return null;
	try {
		const url = new URL(href, "https://www.instagram.com");
		const parts = url.pathname.split("/").filter(Boolean);
		return url.origin === "https://www.instagram.com" &&
			parts.length >= 3 &&
			parts[0]?.toLowerCase() === account.toLowerCase() &&
			parts[1] === "saved"
			? url.href
			: null;
	} catch {
		return null;
	}
}
export async function findInstagramCollection(
	page: InstagramPage,
	account: string,
	name: string,
) {
	const candidates = page.getByText(name, { exact: true });
	await candidates.first().waitFor({ state: "visible", timeout: 5000 });
	for (let i = 0; i < (await candidates.count()); i++) {
		const candidate = candidates.nth(i);
		if (!(await candidate.isVisible())) continue;
		const href = await candidate.evaluate(
			(element) => element.closest("a")?.getAttribute("href") ?? null,
		);
		const verified = collectionHref(href, account);
		if (verified) return verified;
	}
	throw new InstagramCaptureError("open-collection", "collection-unavailable");
}
export function instagramPostUrl(href: string) {
	try {
		const url = new URL(href, "https://www.instagram.com");
		if (url.origin !== "https://www.instagram.com") return null;
		const match = url.pathname.match(
			/^\/(?:[A-Za-z0-9_.]+\/)?(p|reel)\/([A-Za-z0-9_-]+)\/?$/,
		);
		return match ? `https://www.instagram.com/${match[1]}/${match[2]}/` : null;
	} catch {
		return null;
	}
}
export async function discoverInstagramPosts(
	page: InstagramPage,
	maxPages: number,
) {
	await page
		.locator('a[href*="/p/"],a[href*="/reel/"]')
		.first()
		.waitFor({ state: "attached", timeout: 5000 })
		.catch(() => undefined);
	const urls = new Set<string>();
	const passes = Math.max(1, Math.min(5, maxPages));
	for (let pass = 0; pass < passes; pass++) {
		await checkInstagramSession(page, "discover-posts");
		const hrefs = await page
			.locator('a[href*="/p/"],a[href*="/reel/"]')
			.evaluateAll((links) =>
				links.map((link) => link.getAttribute("href") ?? ""),
			);
		for (const href of hrefs) {
			const url = instagramPostUrl(href);
			if (url) urls.add(url);
		}
		if (urls.size >= 250) break;
		if (pass < passes - 1) {
			await page.evaluate(() => {
				const scrolling = document.scrollingElement;
				if (scrolling) scrolling.scrollTop = scrolling.scrollHeight;
			});
			await page.waitForTimeout(500);
		}
	}
	return [...urls].slice(0, 250);
}
