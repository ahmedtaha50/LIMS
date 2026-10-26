import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { apiFetch, errorMessage } from '../lib/api';
import { useToast } from './ui/Toast';

interface HeatmapData {
  role: string;
  hour: number;
  value: number;
}

export function ActivityHeatmap({ token }: { token: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<HeatmapData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { toast } = useToast();

  // apiFetch checks the status and handles an expired session; a failed load is shown, never replaced by an empty chart.
  useEffect(() => {
    let cancelled = false;
    apiFetch<HeatmapData[]>('/admin/activity-heatmap')
      .then(d => { if (!cancelled) { setData(d); setLoadError(null); setLoading(false); } })
      .catch(err => {
        if (cancelled) return;
        const message = errorMessage(err, 'The activity heatmap could not be loaded.');
        setLoadError(message);
        setLoading(false);
        toast(message, 'error');
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (loading || data.length === 0 || !svgRef.current || !containerRef.current) return;

    const margin = { top: 30, right: 30, bottom: 50, left: 80 };
    const width = containerRef.current.clientWidth - margin.left - margin.right;
    const height = 300 - margin.top - margin.bottom;

    // Clear old chart
    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current)
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Labels
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const roles: string[] = Array.from(new Set(data.map(d => String(d.role))));

    // X scale
    const x = d3.scaleBand<string>()
      .range([0, width])
      .domain(hours.map(String))
      .padding(0.05);

    // Add X axis
    svg.append("g")
      .attr("transform", `translate(0, ${height})`)
      .call(d3.axisBottom(x).tickFormat(d => `${d}h`))
      .select(".domain").remove();

    // Y scale
    const y = d3.scaleBand<string>()
      .range([height, 0])
      .domain(roles)
      .padding(0.05);
      
    // Add Y axis
    svg.append("g")
      .call(d3.axisLeft(y).tickSize(0))
      .select(".domain").remove();

    // Build color scale
    const maxVal = d3.max(data, (d: HeatmapData) => Number(d.value)) ?? 10;
    const colorScale = d3.scaleSequential()
      .interpolator(d3.interpolateBlues)
      .domain([0, Number(maxVal)]);

    // Tooltip
    const tooltip = d3.select(containerRef.current)
      .append("div")
      .style("opacity", 0)
      .attr("class", "absolute bg-slate-800 text-white px-3 py-2 rounded text-xs font-mono shadow-lg pointer-events-none");

    // Add rectangles
    svg.selectAll()
      .data(data, (d: any) => d.role + ':' + d.hour)
      .enter()
      .append("rect")
      .attr("x", d => x(String(d.hour)) || 0)
      .attr("y", d => y(d.role) || 0)
      .attr("rx", 4)
      .attr("ry", 4)
      .attr("width", x.bandwidth())
      .attr("height", y.bandwidth())
      .style("fill", d => colorScale(d.value))
      .style("stroke-width", 4)
      .style("stroke", "none")
      .style("opacity", 0.8)
      .on("mouseover", function(event, d) {
        d3.select(this)
          .style("stroke", "black")
          .style("opacity", 1);
        tooltip.style("opacity", 1)
          .html(`Role: <strong>${d.role}</strong><br/>Hour: <strong>${d.hour}:00</strong><br/>Events: <strong>${d.value}</strong>`)
          .style("left", (event.pageX + 10) + "px")
          .style("top", (event.pageY - 20) + "px");
      })
      .on("mouseleave", function() {
        d3.select(this)
          .style("stroke", "none")
          .style("opacity", 0.8);
        tooltip.style("opacity", 0);
      });

  }, [data, loading]);

  if (loading) {
    return <div className="h-[300px] flex items-center justify-center text-slate-500">Loading activity data...</div>;
  }

  if (loadError) {
    return <div role="alert" className="h-[120px] flex items-center justify-center text-red-700 text-sm">{loadError}</div>;
  }
  if (data.length === 0) {
    return <div className="h-[120px] flex items-center justify-center text-slate-500 text-sm">No activity has been recorded yet.</div>;
  }

  return (
    <div ref={containerRef} className="w-full relative">
      <svg ref={svgRef}></svg>
    </div>
  );
}
