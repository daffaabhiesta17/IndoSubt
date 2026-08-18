import { ProviderError, type SubtitleProvider } from './provider.js';
import type { DownloadedSubtitle } from './types.js';
import type { SynchronizationOrchestrator } from './synchronization-orchestrator.js';
import { transformWebVtt } from './webvtt.js';

export interface SynchronizationSubtitleDelivery {
  download(reference: string): Promise<DownloadedSubtitle>;
}

/**
 * Opt-in delivery boundary for completed synchronization tasks.
 *
 * It is deliberately separate from ProviderSubtitleService so existing signed
 * provider references and identity-mapping delivery remain unchanged.
 */
export class OrchestratedSynchronizationSubtitleDelivery
  implements SynchronizationSubtitleDelivery
{
  constructor(
    private readonly provider: SubtitleProvider,
    private readonly orchestrator: SynchronizationOrchestrator
  ) {}

  async download(reference: string): Promise<DownloadedSubtitle> {
    let task;
    try {
      task = await this.orchestrator.getTask(reference);
    } catch {
      throw new ProviderError('not_found', 'Invalid synchronization reference.');
    }
    if (!task || task.status !== 'completed' || task.provider !== this.provider.name) {
      throw new ProviderError('not_found', 'Synchronization task was not found.');
    }

    const subtitle = await this.provider.download(task.providerReference);
    if (!subtitle.contentType.toLowerCase().startsWith('text/vtt')) return subtitle;

    const mapping = await this.orchestrator.getMapping(reference);
    if (!mapping) return subtitle;
    return { ...subtitle, content: transformWebVtt(subtitle.content, mapping) };
  }
}