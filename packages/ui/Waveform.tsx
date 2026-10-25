import { colors } from "crosswing/colors";
import { useEffect, useState } from "react";
import { styled } from "styled-components";

/** How many levels it keeps; a narrow composer shows the latest that fit. */
const BARS = 48;

/** Frames between samples: the bars scroll by about 15 a second. */
const FRAMES_PER_BAR = 4;

/**
 * The microphone's level while dictating, as bars scrolling in from the
 * right (chatwing's AudioVisualization), so you can see it hears you.
 */
export function Waveform({ stream }: { stream: MediaStream }) {
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    void context.resume();

    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let request = 0;
    const animate = () => {
      frame = (frame + 1) % FRAMES_PER_BAR;
      if (frame === 0) {
        analyser.getByteFrequencyData(data);
        // RMS of the spectrum, scaled up: speech rarely gets past 0.4.
        let sum = 0;
        for (const value of data) sum += (value / 255) ** 2;
        const level = Math.min(1, Math.sqrt(sum / data.length) * 2.5);
        setLevels((previous) => [...previous.slice(-(BARS - 1)), level]);
      }
      request = requestAnimationFrame(animate);
    };
    request = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(request);
      source.disconnect();
      void context.close();
    };
  }, [stream]);

  return (
    <StyledWaveform aria-label="Listening">
      {levels.map((level, index) => (
        <div key={index - levels.length} className="bar" style={{ height: Math.max(3, Math.round(level * 20)) }} />
      ))}
    </StyledWaveform>
  );
}

export const StyledWaveform = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  height: 20px;
  overflow: hidden;
  pointer-events: none;
  /* The oldest fade out on the left. */
  mask-image: linear-gradient(90deg, transparent, #000 40px);

  > .bar {
    flex-shrink: 0;
    width: 2px;
    border-radius: 1px;
    background: ${colors.text({ alpha: 0.7 })};
    transition: height 0.15s ease-out;
  }
`;
