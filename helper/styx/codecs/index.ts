// Copied from Trosfy/claude-styx styxd/codecs/index.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by mkh: import paths for this layout.
// Each provider kind's codec. Total over the kinds: a kind added to hooks/config.ts's KINDS needs its codec here.
import type { Kind } from '../../../hooks/config'
import type { Codec } from '../codec'
import { anthropic } from './anthropic'
import { bedrock } from './bedrock'
import { openai } from './openai'

export const CODECS: Readonly<Record<Kind, Codec>> = { openai, anthropic, bedrock }
