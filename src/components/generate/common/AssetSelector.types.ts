export type AssetType = 'image' | 'video' | 'audio'

export interface AssetItem {
  id: string
  url: string
  thumbnailUrl?: string
  type: AssetType
  name?: string
  width?: number
  height?: number
  duration?: number
  createdAt?: string
}
