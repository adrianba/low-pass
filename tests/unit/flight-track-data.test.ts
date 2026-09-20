import { describe, expect, it } from 'vitest';
import { FlightTrack, speedOf } from '../../src/simulation/flight-track';
import { MAX_TRACK_KNOTS, MAX_TRACK_COMPONENT, readFlightTrackData } from '../../src/simulation/flight-track-data';
import { seededCourse } from '../helpers/flight-probe';
import { difficulty } from '../../src/config/game';

const straight = () => new FlightTrack(t => ({ x: 0, y: 100, z: t * 100 }), () => 100, -1, 2);
const editable = () => structuredClone(straight().toData());

describe('authored flight track data', () => {
  it('round-trips every knot, interior pose, timing and speed proof on sequential canyon tiers', () => {
    for (const encounter of seededCourse(7, 'river-canyon', 15)) {
      const original = encounter.canyon!.track;
      const data = JSON.parse(JSON.stringify(original.toData()));
      const imported = FlightTrack.fromData(data);
      expect(imported.knots.length).toBe(original.knots.length);
      imported.assertCoverage(original.startTime, original.endTime);
      expect(imported.respectsSpeed(difficulty(encounter.id - 1).speed)).toBe(true);
      expect(imported.at(0)).toEqual(original.at(0));
      for (let index = 0; index < original.knots.length; index++) {
        const a = original.knots[index]!;
        expect(imported.knots[index]).toEqual(a);
        expect(imported.at(a.time)).toEqual(original.at(a.time));
        expect(imported.timeAt(a.phase)).toBe(original.timeAt(a.phase));
        const b = original.knots[index + 1];
        if (!b) continue;
        for (const alpha of [0.1, 0.5, 0.9]) {
          const time = a.time + (b.time - a.time) * alpha;
          expect(imported.at(time)).toEqual(original.at(time));
        }
      }
    }
  }, 20_000);

  it('returns independent poses and immutable data without retaining caller aliases', () => {
    const original = straight(), data = editable(), imported = FlightTrack.fromData(data);
    const before = imported.at(0);
    Object.assign(data.knots[0]!.pose.position, { x: 900 });
    expect(imported.knots[0]!.pose.position.x).toBe(0);
    for (const time of [imported.startTime - 1, imported.startTime, 0.015, imported.endTime]) {
      const pose = imported.at(time);
      pose.position.x = pose.velocity.z = pose.acceleration.y = 999;
      expect(imported.at(time)).toEqual(original.at(time));
    }
    expect(imported.at(0)).toEqual(before);
    const exported = imported.toData();
    expect(exported.knots).not.toBe(imported.knots);
    expect(() => Object.assign(exported.knots[0]!.pose.position, { x: 1 })).toThrow(TypeError);
    expect(() => Object.assign(imported.knots[0]!.pose.velocity, { x: 1 })).toThrow(TypeError);
    expect(Object.isFrozen(exported)).toBe(true);
    expect(Object.isFrozen(exported.knots)).toBe(true);
  });

  it('canonicalizes signed zero before either side evaluates a JSON-transferred track', () => {
    const data = editable();
    Object.assign(data.knots[0]!.pose, { pitch: -0, bank: -0 });
    const track = FlightTrack.fromData(data);
    expect(Object.is(track.knots[0]!.pose.pitch, 0)).toBe(true);
    expect(FlightTrack.fromData(JSON.parse(JSON.stringify(track.toData()))).at(track.startTime))
      .toEqual(track.at(track.startTime));
  });

  it('retains complete-curve speed checks, rather than trusting endpoint speeds', () => {
    const data = editable();
    Object.assign(data.knots[1]!.pose.position, { x: 50 });
    const imported = FlightTrack.fromData(data);
    expect(imported.knots.every(knot => speedOf(knot.pose) < 100)).toBe(true);
    expect(imported.respectsSpeed(100)).toBe(false);
    for (const limit of [0, -1, NaN, Infinity]) expect(() => imported.respectsSpeed(limit)).toThrow(/limit/);
  });

  it('rejects unsupported, incomplete and oversized data explicitly', () => {
    for (const data of [null, [], {}, { ...editable(), version: 2 },
      { version: 1, knots: [] }, { version: 1, knots: [editable().knots[0]] },
      { version: 1, knots: Array(MAX_TRACK_KNOTS + 1).fill(editable().knots[0]) }]) {
      expect(() => FlightTrack.fromData(data)).toThrow();
    }
  });

  it('rejects invalid vector/attitude fields, ordering and missing release anchors', () => {
    for (const invalid of [NaN, Infinity, -Infinity, MAX_TRACK_COMPONENT * 2, '100', null]) {
      const data = editable();
      Object.assign(data.knots[0]!.pose.position, { x: invalid });
      expect(() => FlightTrack.fromData(data)).toThrow(/bounded finite/);
    }
    for (const update of [{ time: -Infinity }, { time: editable().knots[0]!.time },
      { phase: -2 }, { time: editable().knots[0]!.time + 1e-12 }]) {
      const data = editable();
      Object.assign(data.knots[1]!, update);
      expect(() => FlightTrack.fromData(data)).toThrow();
    }
    const attitude = editable();
    Object.assign(attitude.knots[0]!.pose, { bank: 4 });
    expect(() => readFlightTrackData(attitude)).toThrow(/bank/);
    const missing = editable();
    for (const knot of missing.knots) Object.assign(knot, { phase: knot.phase + 10 });
    expect(() => FlightTrack.fromData(missing)).toThrow(/release anchor/);
  });

  it('checks requested coverage and rejects nonfinite queries without changing solo start clamping', () => {
    const track = straight();
    track.assertCoverage(track.startTime, track.endTime);
    expect(track.at(track.startTime - 1)).toEqual(track.at(track.startTime));
    expect(() => track.at(track.endTime + 0.1)).toThrow(/coverage/);
    expect(() => track.assertCoverage(track.startTime - 0.1, track.endTime)).toThrow(/cover/);
    expect(() => track.assertCoverage(track.startTime, track.endTime + 0.1)).toThrow(/cover/);
    expect(() => track.assertCoverage(1, -1)).toThrow(/cover/);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => track.at(value)).toThrow(/time/);
      expect(() => track.timeAt(value)).toThrow(/phase/);
    }
    expect(() => new FlightTrack(() => ({ x: 0, y: 0, z: 0 }), () => 100, -1e12, 1e12)).toThrow(/range/);
  });
});
