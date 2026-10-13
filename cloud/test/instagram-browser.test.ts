import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import {
	findInstagramCollection,
	discoverInstagramPosts,
	instagramStep,
	instagramPostUrl,
} from "../src/instagram-browser";
import { InstagramCaptureError } from "../src/source-errors";
import { verifyInstagramAccount } from "../../src/lib/instagram-account";
let browser: Browser;
before(async () => {
	browser = await chromium.launch({ headless: true });
});
after(async () => {
	await browser?.close();
});
async function fixture(html: string, path = "/alice/saved/") {
	const page = await browser.newPage();
	await page.route("**/*", (route) =>
		route.fulfill({ contentType: "text/html", body: html }),
	);
	await page.goto(`https://www.instagram.com${path}`);
	return page;
}
test("collection discovery ignores unrelated AI text and rejects foreign or wrong-account destinations", async () => {
	const page = await fixture(
		'<span>AI</span><a href="https://evil.example/alice/saved/folder/1/">AI</a><a href="/bob/saved/folder/2/">AI</a><a href="/alice/saved/ai/42/">AI</a>',
	);
	try {
		assert.equal(
			await findInstagramCollection(page, "alice", "AI"),
			"https://www.instagram.com/alice/saved/ai/42/",
		);
	} finally {
		await page.close();
	}
});
test("bounded discovery scrolls for more posts and canonicalizes only Instagram URLs", async () => {
	const page = await fixture(
		'<a href="/p/first/?tracking=secret">Post</a><a href="https://evil.example/p/foreign/">Bad</a><div style="height:2500px"></div><script>addEventListener("scroll",()=>{if(!document.getElementById("more")){const a=document.createElement("a");a.id="more";a.href="/reel/second/";a.textContent="New reel";document.body.append(a)}})</script>',
	);
	try {
		assert.deepEqual(await discoverInstagramPosts(page, 2), [
			"https://www.instagram.com/p/first/",
			"https://www.instagram.com/reel/second/",
		]);
	} finally {
		await page.close();
	}
	assert.equal(instagramPostUrl("https://evil.example/p/no/"), null);
});
test("login and checkpoint pages report explicit renewal requirements without passwords or page text", async () => {
	for (const [path, reason] of [
		["/accounts/login/", "session-required"],
		["/challenge/abc/", "challenge"],
	]) {
		const page = await fixture(
			'<input name="password" value="do-not-log">',
			path,
		);
		try {
			await assert.rejects(
				instagramStep(page, "open-saved", async () => {}),
				(error) => {
					assert.ok(error instanceof InstagramCaptureError);
					assert.equal(error.reason, reason);
					assert.equal(error.diagnostic().sessionRenewalRequired, true);
					assert.doesNotMatch(JSON.stringify(error.diagnostic()), /do-not-log/);
					return true;
				},
			);
		} finally {
			await page.close();
		}
	}
});
test("current profile-picture navigation verifies the account and rejects a different owner", async () => {
	const page = await fixture(
		'<nav><a href="/alice/"><img alt="alice\'s profile picture" width="32" height="32"></a></nav><main><a href="/bob/"><img alt="bob\'s profile picture" width="32" height="32"></a></main>',
	);
	try {
		await instagramStep(page, "verify-account", () =>
			verifyInstagramAccount(page, "alice"),
		);
		await assert.rejects(
			instagramStep(page, "verify-account", () =>
				verifyInstagramAccount(page, "bob"),
			),
			(error) =>
				error instanceof InstagramCaptureError &&
				error.reason === "account-mismatch",
		);
	} finally {
		await page.close();
	}
});
