import type { CSSProperties, ComponentType } from 'react'
import {
  ArrowLeftOutlined,
  BulbOutlined,
  CloseOutlined,
  CopyOutlined,
  FileOutlined,
  FolderOutlined,
  HomeOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  MenuOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SafetyOutlined,
  SendOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'

const icons = {
  menu: MenuOutlined,
  close: CloseOutlined,
  plus: PlusOutlined,
  info: InfoCircleOutlined,
  folder: FolderOutlined,
  search: SearchOutlined,
  archive: InboxOutlined,
  settings: SettingOutlined,
  activity: ThunderboltOutlined,
  copy: CopyOutlined,
  back: ArrowLeftOutlined,
  chevron: RightOutlined,
  terminal: ThunderboltOutlined,
  file: FileOutlined,
  spark: BulbOutlined,
  send: SendOutlined,
  home: HomeOutlined,
  more: MoreOutlined,
  shield: SafetyOutlined,
} satisfies Record<string, ComponentType<{ className?: string; style?: CSSProperties; 'aria-hidden'?: boolean }>>

export function Icon({ name, size = 18, className = '', style }: { name: keyof typeof icons; size?: number; className?: string; style?: CSSProperties }) {
  const Component = icons[name]
  return <Component aria-hidden="true" className={`pulse-icon ${className}`.trim()} style={{ fontSize: size, ...style }} />
}
