import test from "node:test";
import assert from "node:assert/strict";
import { markerPoint, rotatePoint, tapePins, countPins } from "../public/js/photo-markers.js";

test("marker positions reject missing, nonfinite and out-of-frame evidence without invented dots", () => {
  for (const value of [null, {}, { x: "0.5", y: .2 }, { x: Infinity, y: .5 }, { x: -.1, y: .5 }, { x: .5, y: 1.01 }]) assert.equal(markerPoint(value), null);
  assert.deepEqual(markerPoint({ x: 0, y: 1 }), { x: 0, y: 1 });
  assert.equal(tapePins([{ title: "No position" }, { title: "Located", marker: { x: .2, y: .7 } }]).length, 1);
});

test("rotated photo points stay attached to the same physical pixel and invert correctly", () => {
  const original = { x: .2, y: .7 };
  assert.deepEqual(rotatePoint(original, 90), { x: 1 - .7, y: .2 });
  for (const angle of [0, 90, 180, 270]) {
    const restored = rotatePoint(rotatePoint(original, angle), -angle);
    assert.ok(Math.abs(restored.x - original.x) < 1e-10);
    assert.ok(Math.abs(restored.y - original.y) < 1e-10);
  }
});

test("title numbers preserve batch identity while independent count pins remain separate", () => {
  const tape = tapePins([{ clientId: "copy-one", title: "Jaws", marker: { x: .2, y: .5 }, displayNumber: 9, include: false }])[0];
  assert.equal(tape.number, 9); assert.equal(tape.id, "copy-one"); assert.equal(tape.excluded, true);
  const counts = countPins({ verification: { positions: [{ label: "left spine", marker: { x: .2, y: .5 } }, { label: "uncertain", marker: null }] } });
  assert.equal(counts.length, 1); assert.equal(counts[0].counter, true); assert.notEqual(counts[0].id, tape.id);
});
