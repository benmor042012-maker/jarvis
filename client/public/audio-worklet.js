// Microphone tap. It copies each block of samples to the page and does nothing
// else — no network access is available inside an AudioWorklet, and none is
// wanted: the page turns these samples into a WAV and hands it to the JARVIS
// agent running on this same computer.
class JarvisTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}

registerProcessor("jarvis-tap", JarvisTap);
