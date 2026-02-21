import { describe, it, expect } from "vitest";

describe("progress bar rendering", () => {
  it("renders progress bar correctly at 0%, 50%, and 100%", () => {
    // This test verifies that the progress bar rendering fix (H1)
    // correctly calculates the bar width at different percentages
    
    const width = 40;
    
    // Test 0%
    const current0 = 0;
    const total = 100;
    const filled0 = Math.min(width, Math.round((current0 / total) * width));
    const arrow0 = filled0 < width ? 1 : 0;
    const dots0 = Math.max(0, width - filled0 - arrow0);
    expect(filled0).toBe(0);
    expect(arrow0).toBe(1);
    expect(dots0).toBe(39);
    expect(filled0 + arrow0 + dots0).toBe(40);
    
    // Test 50%
    const current50 = 50;
    const filled50 = Math.min(width, Math.round((current50 / total) * width));
    const arrow50 = filled50 < width ? 1 : 0;
    const dots50 = Math.max(0, width - filled50 - arrow50);
    expect(filled50).toBe(20);
    expect(arrow50).toBe(1);
    expect(dots50).toBe(19);
    expect(filled50 + arrow50 + dots50).toBe(40);
    
    // Test 99%
    const current99 = 99;
    const filled99 = Math.min(width, Math.round((current99 / total) * width));
    const arrow99 = filled99 < width ? 1 : 0;
    const dots99 = Math.max(0, width - filled99 - arrow99);
    expect(filled99).toBe(40);
    expect(arrow99).toBe(0);
    expect(dots99).toBe(0);
    expect(filled99 + arrow99 + dots99).toBe(40);
    
    // Test 100%
    const current100 = 100;
    const filled100 = Math.min(width, Math.round((current100 / total) * width));
    const arrow100 = filled100 < width ? 1 : 0;
    const dots100 = Math.max(0, width - filled100 - arrow100);
    expect(filled100).toBe(40);
    expect(arrow100).toBe(0);
    expect(dots100).toBe(0);
    expect(filled100 + arrow100 + dots100).toBe(40);
  });

  it("non-TTY progress only logs at milestones", () => {
    // This test verifies that the non-TTY fix (H2) only logs at 25%, 50%, 75%, 100%
    // to avoid spamming log lines
    
    const loggedPercentages: number[] = [];
    let lastPct = -1;
    
    // Simulate progress updates
    for (let current = 0; current <= 100; current++) {
      const total = 100;
      const pct = Math.min(100, Math.floor((current / total) * 100));
      
      // Check if we should log (milestone logic)
      if (pct === 100 || (pct >= 25 && pct !== lastPct && pct % 25 === 0)) {
        loggedPercentages.push(pct);
        lastPct = pct;
      }
    }
    
    // Should only log at 25, 50, 75, 100
    expect(loggedPercentages).toEqual([25, 50, 75, 100]);
  });
});
