/**
 * Audio Effects Service
 * Manages game sound effects and music
 */

type SoundEffect = 'vote' | 'approval' | 'rejection' | 'quest-success' | 'quest-fail' | 'game-start' | 'game-end' | 'notification';

interface AudioConfig {
  enabled: boolean;
  volume: number; // 0-1
}

class AudioService {
  private config: AudioConfig = {
    enabled: true,
    volume: 0.5,
  };

  private audioContext: AudioContext | null = null;
  private oscillators: Map<string, OscillatorNode> = new Map();

  constructor() {
    this.loadConfig();
  }

  /**
   * Initialize audio context
   */
  private initAudioContext(): void {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }

  /**
   * Load audio config from localStorage
   */
  private loadConfig(): void {
    const saved = localStorage.getItem('audioConfig');
    if (saved) {
      this.config = JSON.parse(saved);
    }
  }

  /**
   * Save audio config to localStorage
   */
  private saveConfig(): void {
    localStorage.setItem('audioConfig', JSON.stringify(this.config));
  }

  /**
   * Play a sound effect using Web Audio API
   */
  playSound(sound: SoundEffect): void {
    if (!this.config.enabled) return;

    this.initAudioContext();
    if (!this.audioContext) return;

    const soundConfigs: Record<SoundEffect, { frequency: number; duration: number; type: OscillatorType }> = {
      vote: { frequency: 440, duration: 0.1, type: 'sine' },
      approval: { frequency: 523, duration: 0.2, type: 'sine' },
      rejection: { frequency: 349, duration: 0.2, type: 'sine' },
      'quest-success': { frequency: 659, duration: 0.3, type: 'sine' },
      'quest-fail': { frequency: 262, duration: 0.3, type: 'sine' },
      'game-start': { frequency: 587, duration: 0.5, type: 'sine' },
      'game-end': { frequency: 523, duration: 0.5, type: 'sine' },
      notification: { frequency: 800, duration: 0.15, type: 'sine' },
    };

    const config = soundConfigs[sound];
    this.playTone(config.frequency, config.duration, config.type);
  }

  /**
   * Play a tone with given frequency and duration
   */
  private playTone(frequency: number, duration: number, type: OscillatorType = 'sine'): void {
    if (!this.audioContext) return;

    const now = this.audioContext.currentTime;
    const gainNode = this.audioContext.createGain();
    const oscillator = this.audioContext.createOscillator();

    oscillator.frequency.value = frequency;
    oscillator.type = type;

    // Envelope
    gainNode.gain.setValueAtTime(this.config.volume, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  /**
   * Play success chord (3 tones)
   */
  playSuccessChord(): void {
    if (!this.config.enabled) return;

    this.playSound('quest-success');
    setTimeout(() => this.playSound('approval'), 100);
    setTimeout(() => this.playSound('game-start'), 200);
  }

  /**
   * Play failure sound
   */
  playFailureSound(): void {
    if (!this.config.enabled) return;

    this.playSound('quest-fail');
    setTimeout(() => this.playSound('rejection'), 150);
  }

  /**
   * Toggle audio on/off
   */
  toggleAudio(): void {
    this.config.enabled = !this.config.enabled;
    this.saveConfig();
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    this.config.volume = Math.max(0, Math.min(1, volume));
    this.saveConfig();
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.config.volume;
  }

  /**
   * Check if audio is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get audio config
   */
  getConfig(): AudioConfig {
    return { ...this.config };
  }
}

// Singleton instance
const audioService = new AudioService();
export default audioService;
