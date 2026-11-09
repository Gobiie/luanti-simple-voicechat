import test from "node:test";
import assert from "node:assert/strict";

import { TokenStore } from "../src/tokens.js";

test("issues a long token and a six character code", () => {
	const store = new TokenStore(60_000);
	const grant = store.issue("alice");
	assert.match(grant.token, /^[A-Za-z0-9_-]{20,}$/);
	assert.match(grant.code, /^[A-HJ-NP-Z2-9]{6}$/);
	assert.equal(grant.expires_in, 60);
});

test("a token can only be consumed once", () => {
	const store = new TokenStore(60_000);
	const grant = store.issue("alice");
	assert.equal(store.consume(grant.token), "alice");
	assert.equal(store.consume(grant.token), null);
});

test("a code can only be consumed once and is case insensitive", () => {
	const store = new TokenStore(60_000);
	const grant = store.issue("bob");
	assert.equal(store.consume(grant.code.toLowerCase()), "bob");
	assert.equal(store.consume(grant.code), null);
});

test("codes and tokens of the same grant revoke each other", () => {
	const store = new TokenStore(60_000);
	const grant = store.issue("carol");
	assert.equal(store.consume(grant.code), "carol");
	assert.equal(store.consume(grant.token), null);
});

test("reissuing revokes the previous grant", () => {
	const store = new TokenStore(60_000);
	const first = store.issue("dave");
	const second = store.issue("dave");
	assert.equal(store.consume(first.token), null);
	assert.equal(store.consume(second.token), "dave");
});

test("expired grants are rejected and pruned", () => {
	let now = 1000;
	const store = new TokenStore(5000, { now: () => now });
	const grant = store.issue("erin");
	now += 5001;
	assert.equal(store.consume(grant.token), null);

	const other = store.issue("frank");
	now += 6000;
	assert.equal(store.byToken.size, 1);
	store.prune();
	assert.equal(store.byToken.size, 0);
	assert.equal(store.consume(other.code), null);
});
