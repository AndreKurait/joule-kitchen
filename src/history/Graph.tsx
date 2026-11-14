import { useMemo, useState } from 'react';
import type { Sample, Unit } from '../types.ts';
import { formatTemperature } from '../types.ts';

const W = 850,
  H = 270,
  LEFT = 46,
  RIGHT = 16,
  TOP = 24,
  BOTTOM = 35;
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function TemperatureGraph({
  samples,
  unit,
  showTarget,
}: {
  samples: Sample[];
  unit: Unit;
  showTarget: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const graph = useMemo(() => {
    // Keep a bounded SVG. The full recording is retained for CSV export.
    // Bucket min/max preserves short spikes that every-Nth sampling loses.
    let points = samples.map((sample, i) =>
      i > 0 && sample.at - samples[i - 1]!.at > 15000 ? { ...sample, gapBefore: true } : sample,
    );
    if (samples.length > 2000) {
      const stride = Math.ceil(samples.length / 800);
      const original = points;
      points = [];
      for (let i = 0; i < samples.length; i += stride) {
        const bucket = original.slice(i, i + stride);
        const valid = bucket.filter((sample) => sample.temperatureC !== null);
        const low = valid.reduce<Sample | undefined>(
          (a, b) => (!a || b.temperatureC! < a.temperatureC! ? b : a),
          undefined,
        );
        const high = valid.reduce<Sample | undefined>(
          (a, b) => (!a || b.temperatureC! > a.temperatureC! ? b : a),
          undefined,
        );
        const selected = new Set([
          bucket[0]!,
          bucket[bucket.length - 1]!,
          ...bucket.filter((p) => p.gapBefore),
        ]);
        if (low) selected.add(low);
        if (high) selected.add(high);
        points.push(...[...selected].sort((a, b) => a.at - b.at));
      }
    }
    const values = points
      .flatMap((p) => [p.temperatureC, ...(showTarget ? [p.targetC] : [])])
      .filter((x): x is number => x !== null);
    const min = values.length ? Math.floor(Math.min(...values) - 2) : 20;
    const max = values.length ? Math.ceil(Math.max(...values) + 2) : 60;
    const from = points[0]?.at ?? Date.now() - 60000;
    const to = Math.max(points[points.length - 1]?.at ?? Date.now(), from + 60000);
    const x = (at: number) => LEFT + ((at - from) / (to - from)) * (W - LEFT - RIGHT);
    const y = (value: number) => TOP + ((max - value) / (max - min)) * (H - TOP - BOTTOM);
    function path(field: 'temperatureC' | 'targetC') {
      let path = '',
        previous: Sample | null = null;
      for (const sample of points) {
        const value = sample[field];
        if (value === null) {
          previous = null;
          continue;
        }
        const gap = !previous || sample.gapBefore;
        if (gap) path += `M${x(sample.at).toFixed(1)},${y(value).toFixed(1)}`;
        else if (field === 'targetC') path += `H${x(sample.at).toFixed(1)}V${y(value).toFixed(1)}`;
        else path += `L${x(sample.at).toFixed(1)},${y(value).toFixed(1)}`;
        previous = sample;
      }
      return path;
    }
    return {
      points,
      min,
      max,
      from,
      to,
      x,
      y,
      actual: path('temperatureC'),
      target: path('targetC'),
    };
  }, [samples, showTarget]);
  const selected =
    hovered === null ? null : (graph.points[Math.min(hovered, graph.points.length - 1)] ?? null);
  const closest = (clientX: number, bounds: DOMRect) => {
    const at =
      graph.from +
      ((((clientX - bounds.left) / bounds.width) * W - LEFT) / (W - LEFT - RIGHT)) *
        (graph.to - graph.from);
    let best = 0;
    graph.points.forEach((p, i) => {
      if (Math.abs(p.at - at) < Math.abs(graph.points[best]!.at - at)) best = i;
    });
    setHovered(best);
  };
  return (
    <div className="graph">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Temperature over time in degrees ${unit === 'C' ? 'Celsius' : 'Fahrenheit'}. ${samples.length} readings.`}
        tabIndex={samples.length ? 0 : undefined}
        onPointerMove={(event) =>
          closest(event.clientX, event.currentTarget.getBoundingClientRect())
        }
        onPointerLeave={() => setHovered(null)}
        onKeyDown={(event) => {
          if (!graph.points.length) return;
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setHovered((index) =>
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? graph.points.length - 1
                : Math.max(
                    0,
                    Math.min(
                      graph.points.length - 1,
                      (index ?? 0) + (event.key === 'ArrowRight' ? 1 : -1),
                    ),
                  ),
          );
        }}
      >
        <title>Measured bath temperature and requested target</title>
        {[0, 1, 2, 3, 4].map((i) => {
          const value = graph.min + ((graph.max - graph.min) * i) / 4;
          return (
            <g key={i}>
              <line
                className="grid-line"
                x1={LEFT}
                x2={W - RIGHT}
                y1={graph.y(value)}
                y2={graph.y(value)}
              />
              <text className="axis-text" x={LEFT - 9} y={graph.y(value) + 4} textAnchor="end">
                {Number(formatTemperature(value, unit)).toFixed(0)}°
              </text>
            </g>
          );
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const at = graph.from + (graph.to - graph.from) * fraction;
          return (
            <text
              key={fraction}
              className="axis-text"
              x={graph.x(at)}
              y={H - 10}
              textAnchor="middle"
            >
              {new Date(at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                ...(graph.to - graph.from < 900000 ? { second: '2-digit' as const } : {}),
              })}
            </text>
          );
        })}
        {showTarget && <path className="target-line" d={graph.target} data-testid="target-path" />}
        <path className="temperature-line" d={graph.actual} data-testid="temperature-path" />
        {graph.points.length === 1 && graph.points[0]!.temperatureC !== null && (
          <circle
            r="4"
            fill="var(--accent)"
            cx={graph.x(graph.points[0]!.at)}
            cy={graph.y(graph.points[0]!.temperatureC!)}
          />
        )}
        {selected && (
          <>
            <line
              className="cursor-line"
              x1={graph.x(selected.at)}
              x2={graph.x(selected.at)}
              y1={TOP}
              y2={H - BOTTOM}
            />
            {selected.temperatureC !== null && (
              <circle
                cx={graph.x(selected.at)}
                cy={graph.y(selected.temperatureC)}
                r="5"
                className="graph-dot"
              />
            )}
          </>
        )}
      </svg>
      {!samples.length && (
        <div className="graph-empty">
          <span className="empty-wave">∿</span>
          <strong>Your next cook starts here.</strong>
          <span>Pair a Joule to record its temperature curve.</span>
        </div>
      )}
      <div className="graph-caption" aria-live="polite">
        {selected ? (
          <>
            <span>{time(selected.at)}</span>
            <strong>
              {formatTemperature(selected.temperatureC, unit)}°{unit}
            </strong>
            <span>
              Target {formatTemperature(selected.targetC, unit)}°{unit}
            </span>
            {selected.gapBefore && <span>After a recording gap</span>}
          </>
        ) : (
          <>
            <span>
              <i className="legend-dot" />
              Bath
            </span>
            {showTarget && (
              <span>
                <i className="legend-dash" />
                Target
              </span>
            )}
            <span className="graph-hint">Hover or use arrow keys to inspect</span>
          </>
        )}
      </div>
    </div>
  );
}
