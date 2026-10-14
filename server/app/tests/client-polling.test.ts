import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('iOS uses WebSocket events and a low-rate snapshot fallback', async () => {
  const source = await readFile('../frontend/ios/PS5LibraryCompanion/Store.swift', 'utf8');
  assert.match(source, /Task\.sleep\s*\(\s*nanoseconds:\s*30_000_000_000\s*\)/);
  assert.match(source, /api\.events\s*\(\s*after:\s*cursor\s*\)/);
  assert.doesNotMatch(source, /Task\.sleep\s*\(\s*nanoseconds:\s*10_000_000_000\s*\)/);
});
