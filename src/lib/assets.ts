// src/lib/assets.ts
import { supabase } from './supabaseClient'

export const ASSET_POLICY = {
  pdfs: { bucket: 'pdfs', access: 'public' as const, signedTtl: 3600 },
  audio: { bucket: 'student-audio', access: 'signed' as const, signedTtl: 3600 },
  thumbnails: { bucket: 'thumbnails', access: 'public' as const, signedTtl: 3600 }
}

export async function getAssetUrl(kind: keyof typeof ASSET_POLICY, path: string): Promise<string> {
  const policy = ASSET_POLICY[kind]
  if (policy.access === 'public') {
    const { data } = supabase.storage.from(policy.bucket).getPublicUrl(path)
    return data.publicUrl
  } else {
    const { data, error } = await supabase.storage.from(policy.bucket).createSignedUrl(path, policy.signedTtl)
    if (error) throw error
    return data.signedUrl
  }
}
