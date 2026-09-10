import { strict as assert } from "node:assert";
import test from "node:test";
import { SourceLifecycle } from "../src/source-lifecycle.js";

test("closing and reopening a source starts a new detection", () => {
  const lifecycle = new SourceLifecycle();
  const sourcePath = "/workspace/secret.yaml";

  assert.equal(lifecycle.beginDetection(sourcePath), true);
  assert.equal(lifecycle.detectionCompleted(sourcePath, true), true);
  lifecycle.sessionOpened(sourcePath);
  lifecycle.sessionClosed(sourcePath);
  lifecycle.sourceClosed(sourcePath);

  assert.equal(lifecycle.sourceOpened(sourcePath), "detect");
});

test("closing a source does not discard its live decrypted session", () => {
  const lifecycle = new SourceLifecycle();
  const sourcePath = "/workspace/secret.yaml";

  assert.equal(lifecycle.beginDetection(sourcePath), true);
  assert.equal(lifecycle.detectionCompleted(sourcePath, true), true);
  lifecycle.sessionOpened(sourcePath);
  lifecycle.sourceClosed(sourcePath);

  assert.equal(lifecycle.sourceOpened(sourcePath), "ignore");
  lifecycle.sessionClosed(sourcePath);
  assert.equal(lifecycle.sourceOpened(sourcePath), "detect");
});

test("closing a source cancels an in-flight detection", () => {
  const lifecycle = new SourceLifecycle();
  const sourcePath = "/workspace/secret.yaml";

  assert.equal(lifecycle.beginDetection(sourcePath), true);
  lifecycle.sourceClosed(sourcePath);

  assert.equal(lifecycle.detectionCompleted(sourcePath, true), false);
  assert.equal(lifecycle.sourceOpened(sourcePath), "detect");
});

test("a known encrypted source opens without another detection", () => {
  const lifecycle = new SourceLifecycle();
  const sourcePath = "/workspace/secret.yaml";

  assert.equal(lifecycle.beginDetection(sourcePath), true);
  assert.equal(lifecycle.detectionCompleted(sourcePath, true), true);

  assert.equal(lifecycle.sourceOpened(sourcePath), "open");
});

test("a known plain source is ignored until its tab closes", () => {
  const lifecycle = new SourceLifecycle();
  const sourcePath = "/workspace/plain.yaml";

  assert.equal(lifecycle.beginDetection(sourcePath), true);
  assert.equal(lifecycle.detectionCompleted(sourcePath, false), true);
  assert.equal(lifecycle.sourceOpened(sourcePath), "ignore");
  lifecycle.sourceClosed(sourcePath);

  assert.equal(lifecycle.sourceOpened(sourcePath), "detect");
});

test("encrypt in place promotes a known plain source into a decrypted session", () => {
  const lifecycle = new SourceLifecycle();
  const sourcePath = "/workspace/plain.yaml";

  assert.equal(lifecycle.beginDetection(sourcePath), true);
  assert.equal(lifecycle.detectionCompleted(sourcePath, false), true);
  lifecycle.markEncrypted(sourcePath);
  assert.equal(lifecycle.sourceOpened(sourcePath), "open");

  lifecycle.sessionOpened(sourcePath);
  lifecycle.sourceClosed(sourcePath);
  assert.equal(lifecycle.sourceOpened(sourcePath), "ignore");
});
