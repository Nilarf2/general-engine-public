// Browser audio/effect adapter contract adapted from Nilarf2/text-adventure-engine (MIT), © 2026 Nilarf2.
import type {
  AssetDefinition,
  AudioChannel,
  RuntimeEffect,
  SessionSnapshot,
  SessionState,
  Story,
} from './workflow-types.js';

export type AssetResolver = (assetId: string, definition?: AssetDefinition) => string | undefined | null | Promise<string | undefined | null>;
export interface AudioFailureContext { operation: string; assetId?: string; channel?: AudioChannel }
export interface AudioAdapterOptions {
  assets?: Story['assets'];
  resolveAsset?: AssetResolver;
  onError?: (error: unknown, context: AudioFailureContext) => void;
  createAudio?: (source: string) => HTMLAudioElement;
  fadeTickMs?: number;
}
export interface FadeOptions { fadeMs?: number }
export interface WebMusicOptions extends FadeOptions { loop?: boolean; volume?: number; channel?: AudioChannel }
export interface AudioPort {
  playMusic(assetId: string, options?: WebMusicOptions): Promise<void>;
  playAmbience(assetId: string, options?: Omit<WebMusicOptions, 'channel'>): Promise<void>;
  playSfx(assetId: string, volume?: number): Promise<void>;
  stopMusic(options?: FadeOptions): Promise<void>;
  stopAmbience(options?: FadeOptions): Promise<void>;
  pause(channel?: AudioChannel): void;
  resume(channel?: AudioChannel): Promise<void>;
  setVolume(channel: AudioChannel, volume: number, fadeMs?: number): Promise<void>;
  unlock(): Promise<void>;
  handleEffect(effect: RuntimeEffect): Promise<void>;
  reconcile(snapshot: SessionSnapshot | SessionState): Promise<void>;
  dispose(): void;
}

interface TrackHandle {
  assetId: string;
  audio: HTMLAudioElement;
  targetVolume: number;
  shouldPlay: boolean;
  pendingFadeMs: number;
}
interface FadeJob { timer: ReturnType<typeof setInterval>; settle: () => void }

/**
 * Browser audio adapter for serializable narrative effects. Audio creation and
 * asset lookup are injected so the adapter can be tested without a DOM.
 */
export class WebAudioAdapter implements AudioPort {
  private readonly channels = new Map<AudioChannel, TrackHandle>();
  private readonly generations = new Map<AudioChannel, number>();
  private readonly fades = new Map<AudioChannel, FadeJob>();
  private readonly soundEffects = new Set<HTMLAudioElement>();
  private readonly blockedEffects = new Set<HTMLAudioElement>();
  private readonly createAudio: (source: string) => HTMLAudioElement;
  private disposed = false;

  constructor(private readonly options: AudioAdapterOptions = {}) {
    this.createAudio = options.createAudio ?? (source => {
      const audio = new Audio(source);
      audio.preload = 'auto';
      return audio;
    });
  }

  async playMusic(assetId: string, options: WebMusicOptions = {}): Promise<void> { await this.playTrack(assetId, options.channel ?? 'music', options); }
  async playAmbience(assetId: string, options: Omit<WebMusicOptions, 'channel'> = {}): Promise<void> { await this.playTrack(assetId, 'ambience', options); }
  async playSfx(assetId: string, volume = 1): Promise<void> {
    if (this.disposed) return;
    try {
      const source = await this.resolveAsset(assetId);
      if (this.disposed) return;
      const audio = this.createAudio(source);
      audio.loop = false;
      audio.volume = this.clamp(volume);
      this.soundEffects.add(audio);
      audio.onended = () => this.releaseSfx(audio);
      const played = await this.tryPlay(audio, { operation: 'playSfx', assetId });
      if (!played) this.blockedEffects.add(audio);
    } catch (error) { this.report(error, { operation: 'playSfx', assetId }); }
  }
  async stopMusic(options: FadeOptions = {}): Promise<void> { await this.stop('music', options); }
  async stopAmbience(options: FadeOptions = {}): Promise<void> { await this.stop('ambience', options); }
  async stop(channel: AudioChannel, options: FadeOptions = {}): Promise<void> {
    const generation = this.nextGeneration(channel);
    const handle = this.channels.get(channel);
    if (!handle) return;
    await this.fadeTo(channel, handle, 0, options.fadeMs ?? 0, generation);
    if (this.disposed || generation !== this.generation(channel) || this.channels.get(channel) !== handle) return;
    this.channels.delete(channel);
    this.releaseTrack(handle);
  }
  pause(channel: AudioChannel = 'music'): void {
    this.nextGeneration(channel);
    const handle = this.channels.get(channel);
    if (!handle) return;
    this.cancelFade(channel);
    handle.shouldPlay = false;
    try { handle.audio.pause(); } catch (error) { this.report(error, { operation: 'pause', assetId: handle.assetId, channel }); }
  }
  async resume(channel: AudioChannel = 'music'): Promise<void> {
    const handle = this.channels.get(channel);
    if (!handle || this.disposed) return;
    handle.shouldPlay = true;
    const played = await this.tryPlay(handle.audio, { operation: 'resume', assetId: handle.assetId, channel });
    if (played && handle.pendingFadeMs > 0) {
      const fade = handle.pendingFadeMs;
      handle.pendingFadeMs = 0;
      await this.fadeTo(channel, handle, handle.targetVolume, fade, this.generation(channel));
    }
  }
  async setVolume(channel: AudioChannel, volume: number, fadeMs = 0): Promise<void> {
    const handle = this.channels.get(channel);
    if (!handle) return;
    handle.targetVolume = this.clamp(volume);
    await this.fadeTo(channel, handle, handle.targetVolume, fadeMs, this.nextGeneration(channel));
  }
  async unlock(): Promise<void> {
    if (this.disposed) return;
    for (const [channel, handle] of this.channels) {
      if (!handle.shouldPlay || !handle.audio.paused) continue;
      const played = await this.tryPlay(handle.audio, { operation: 'unlock', assetId: handle.assetId, channel });
      if (played && handle.pendingFadeMs > 0) {
        const fade = handle.pendingFadeMs;
        handle.pendingFadeMs = 0;
        await this.fadeTo(channel, handle, handle.targetVolume, fade, this.generation(channel));
      }
    }
    for (const audio of [...this.blockedEffects]) {
      if (this.disposed) break;
      if (await this.tryPlay(audio, { operation: 'unlockSfx' })) this.blockedEffects.delete(audio);
    }
  }
  async handleEffect(effect: RuntimeEffect): Promise<void> {
    if (this.disposed) return;
    try {
      switch (effect.type) {
        case 'audio.play': await this.playTrack(effect.track.asset, effect.channel, { loop: effect.track.loop, volume: effect.track.volume, fadeMs: effect.fadeMs }); break;
        case 'audio.stop': await this.stop(effect.channel, { fadeMs: effect.fadeMs }); break;
        case 'audio.sfx': await this.playSfx(effect.asset, effect.volume); break;
      }
    } catch (error) { this.report(error, { operation: `effect:${effect.type}` }); }
  }
  async reconcile(snapshot: SessionSnapshot | SessionState): Promise<void> {
    const state = 'state' in snapshot ? snapshot.state : snapshot;
    for (const channel of ['music', 'ambience'] as const) {
      const track = state.audio[channel];
      if (track) await this.playTrack(track.asset, channel, { loop: track.loop, volume: track.volume });
      else await this.stop(channel);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of ['music', 'ambience'] as const) {
      this.nextGeneration(channel);
      const handle = this.channels.get(channel);
      if (handle) this.releaseTrack(handle);
      this.cancelFade(channel);
    }
    this.channels.clear();
    for (const audio of this.soundEffects) this.releaseSfx(audio);
    this.blockedEffects.clear();
  }

  private async playTrack(assetId: string, channel: AudioChannel, options: WebMusicOptions): Promise<void> {
    if (this.disposed) return;
    const generation = this.nextGeneration(channel);
    try {
      const source = await this.resolveAsset(assetId);
      if (this.disposed || generation !== this.generation(channel)) return;
      const previous = this.channels.get(channel);
      if (previous && previous.assetId === assetId) {
        previous.shouldPlay = true;
        previous.audio.loop = options.loop ?? previous.audio.loop;
        previous.targetVolume = this.clamp(options.volume ?? previous.targetVolume);
        if (options.fadeMs !== undefined) await this.fadeTo(channel, previous, previous.targetVolume, options.fadeMs, generation);
        else await this.tryPlay(previous.audio, { operation: 'playTrack', assetId, channel });
        return;
      }
      const audio = this.createAudio(source);
      audio.loop = options.loop ?? true;
      const targetVolume = this.clamp(options.volume ?? 1);
      audio.volume = options.fadeMs && options.fadeMs > 0 ? 0 : targetVolume;
      const handle: TrackHandle = { assetId, audio, targetVolume, shouldPlay: true, pendingFadeMs: options.fadeMs ?? 0 };
      if (previous) this.releaseTrack(previous);
      this.channels.set(channel, handle);
      const played = await this.tryPlay(audio, { operation: 'playTrack', assetId, channel });
      if (!played) return;
      if (options.fadeMs && options.fadeMs > 0) {
        await this.fadeTo(channel, handle, handle.targetVolume, options.fadeMs, generation);
      }
    } catch (error) { this.report(error, { operation: 'playTrack', assetId, channel }); }
  }
  private async resolveAsset(assetId: string): Promise<string> {
    const definition = this.options.assets?.[assetId];
    const source = this.options.resolveAsset ? await this.options.resolveAsset(assetId, definition) : definition?.src ?? assetId;
    if (!source) throw new Error(`Unable to resolve audio asset: ${assetId}`);
    return source;
  }
  private async tryPlay(audio: HTMLAudioElement, context: AudioFailureContext): Promise<boolean> {
    try { await audio.play(); return true; }
    catch (error) { this.report(error, context); return false; }
  }
  private async fadeTo(channel: AudioChannel, handle: TrackHandle, target: number, duration: number, generation: number): Promise<void> {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Fade duration must be finite and nonnegative');
    this.cancelFade(channel);
    const audio = handle.audio;
    if (!duration || duration <= 0) { audio.volume = target; return; }
    const start = audio.volume;
    const started = Date.now();
    const interval = Math.max(10, this.options.fadeTickMs ?? 30);
    await new Promise<void>(resolve => {
      const timer = setInterval(() => {
        if (this.disposed || generation !== this.generation(channel) || this.channels.get(channel) !== handle) { clearInterval(timer); this.fades.delete(channel); resolve(); return; }
        const progress = Math.min(1, (Date.now() - started) / duration);
        audio.volume = start + (target - start) * progress;
        if (progress >= 1) { clearInterval(timer); this.fades.delete(channel); resolve(); }
      }, interval);
      this.fades.set(channel, { timer, settle: resolve });
    });
  }
  private nextGeneration(channel: AudioChannel): number { const next = this.generation(channel) + 1; this.generations.set(channel, next); this.cancelFade(channel); return next; }
  private generation(channel: AudioChannel): number { return this.generations.get(channel) ?? 0; }
  private cancelFade(channel: AudioChannel): void { const fade = this.fades.get(channel); if (fade) { clearInterval(fade.timer); this.fades.delete(channel); fade.settle(); } }
  private releaseTrack(handle: TrackHandle): void { try { handle.audio.pause(); } catch {} handle.audio.onended = null; handle.audio.onerror = null; }
  private releaseSfx(audio: HTMLAudioElement): void { this.soundEffects.delete(audio); this.blockedEffects.delete(audio); try { audio.pause(); } catch {} audio.onended = null; audio.onerror = null; }
  private clamp(value: number): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Audio volume must be between 0 and 1'); return value; }
  private report(error: unknown, context: AudioFailureContext): void { try { this.options.onError?.(error, context); } catch { /* Error reporters are application-owned. */ } }
}

export interface NarrativeWebAdapterOptions {
  audio?: AudioPort;
  onScene?: (scene: { id: string; background?: string }) => void | Promise<void>;
  onModuleRequest?: (request: Extract<RuntimeEffect, { type: 'module.request' }>['request']) => void | Promise<void>;
  onCheckpoint?: (name: string | undefined) => void | Promise<void>;
  onEvent?: (event: { type: string; payload?: import('./workflow-types.js').JsonValue }) => void | Promise<void>;
  onEffect?: (effect: RuntimeEffect) => void | Promise<void>;
}

/** Dispatches session effects to host-owned scene, module and audio adapters. */
export class NarrativeWebAdapter {
  constructor(private readonly options: NarrativeWebAdapterOptions = {}) {}
  async apply(effects: readonly RuntimeEffect[], events: readonly { type: string; payload?: import('./workflow-types.js').JsonValue }[] = []): Promise<void> {
    for (const event of events) await this.options.onEvent?.(event);
    for (const effect of effects) {
      if (effect.type.startsWith('audio.') && this.options.audio) { await this.options.audio.handleEffect(effect); continue; }
      if (effect.type === 'scene') { await this.options.onScene?.({ id: effect.scene, ...(effect.background === undefined ? {} : { background: effect.background }) }); continue; }
      if (effect.type === 'module.request') { await this.options.onModuleRequest?.(effect.request); continue; }
      if (effect.type === 'checkpoint') { await this.options.onCheckpoint?.(effect.name); continue; }
      await this.options.onEffect?.(effect);
    }
  }
  async reconcile(snapshot: SessionSnapshot | SessionState): Promise<void> { await this.options.audio?.reconcile(snapshot); }
  dispose(): void { this.options.audio?.dispose(); }
}

export function createNarrativeWebAdapter(options: NarrativeWebAdapterOptions = {}): NarrativeWebAdapter { return new NarrativeWebAdapter(options); }
