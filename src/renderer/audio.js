// Procedural 8-Bit Web Audio API Sound Synthesizer
class SoundFX {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('sound_muted') === 'true';
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('sound_muted', this.muted);
    return this.muted;
  }

  playTone(freq, type, duration, startTime = 0, gainLevel = 0.1) {
    if (this.muted) return;
    this.init();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime + startTime);

    gain.gain.setValueAtTime(gainLevel, this.ctx.currentTime + startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + startTime + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(this.ctx.currentTime + startTime);
    osc.stop(this.ctx.currentTime + startTime + duration);
  }

  // Attention Alert (!) when bot needs user input
  playAlert() {
    if (this.muted) return;
    // Retro 2-tone alert chime (E6 -> A6)
    this.playTone(659.25, 'square', 0.12, 0, 0.08);
    this.playTone(880.00, 'square', 0.20, 0.12, 0.10);
  }

  // Level up / task completed fanfare
  playSuccess() {
    if (this.muted) return;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      this.playTone(freq, 'triangle', 0.15, idx * 0.1, 0.09);
    });
  }

  // Wake up chime
  playWakeup() {
    if (this.muted) return;
    this.playTone(440, 'sine', 0.1, 0, 0.06);
    this.playTone(554.37, 'sine', 0.12, 0.08, 0.07);
    this.playTone(659.25, 'sine', 0.18, 0.16, 0.08);
  }

  // UI click / key blip
  playBlip() {
    if (this.muted) return;
    this.playTone(987.77, 'square', 0.04, 0, 0.03);
  }
}

window.soundFX = new SoundFX();
