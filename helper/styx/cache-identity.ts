import { createHash } from 'node:crypto'
import type { Kind } from '../../hooks/config'

export type CacheIdentity = {
  providerId: string
  providerKind: Kind
  endpointOrigin: string
  modelKind: Kind
  modelId: string
  session: string
  owner: string
}

// Only reference identity enters the digest. endpointOrigin is the validated URL origin, not the URL path,
// credentials, query, auth command, or provider key.
export function cacheIdentityKey(identity: CacheIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'rice-multi-models:styx-cache-identity:v1',
      identity.providerId,
      identity.providerKind,
      identity.endpointOrigin,
      identity.modelKind,
      identity.modelId,
      identity.session,
      identity.owner,
    ]))
    .digest('hex')
}
