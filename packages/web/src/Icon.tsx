import type { CSSProperties, ComponentType } from 'react'
import {
  PushpinOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  DownOutlined,
  ReloadOutlined,
  AuditOutlined,
  BulbOutlined,
  CloseOutlined,
  CopyOutlined,
  DownloadOutlined,
  UploadOutlined,
  FileOutlined,
  EditOutlined,
  GlobalOutlined,
  ToolOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  FolderAddOutlined,
  HomeOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  MenuOutlined,
  MoreOutlined,
  EllipsisOutlined,
  PlusSquareOutlined,
  UnorderedListOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SafetyOutlined,
  SendOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'

function RoundedChevron({ className = '', style }: { className?: string; style?: CSSProperties; 'aria-hidden'?: boolean }) {
  return <span aria-hidden="true" className={`anticon ${className}`.trim()} style={style}>
    <svg viewBox="0 0 20 20" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7.5 4.5 5.5 5.5-5.5 5.5"/></svg>
  </span>
}

const icons = {
  pin: PushpinOutlined,
  message: MessageOutlined,
  up: ArrowUpOutlined,
  down: DownOutlined,
  menu: MenuOutlined,
  close: CloseOutlined,
  plus: PlusOutlined,
  info: InfoCircleOutlined,
  folder: FolderOutlined,
  'folder-open': FolderOpenOutlined,
  'folder-add': FolderAddOutlined,
  search: SearchOutlined,
  archive: InboxOutlined,
  settings: SettingOutlined,
  activity: ThunderboltOutlined,
  copy: CopyOutlined,
  download: DownloadOutlined,
  upload: UploadOutlined,
  back: ArrowLeftOutlined,
  reload: ReloadOutlined,
  chevron: RightOutlined,
  'chevron-rounded': RoundedChevron,
  terminal: ThunderboltOutlined,
  file: FileOutlined,
  edit: EditOutlined,
  web: GlobalOutlined,
  tool: ToolOutlined,
  spark: BulbOutlined,
  send: SendOutlined,
  home: HomeOutlined,
  more: MoreOutlined,
  ellipsis: EllipsisOutlined,
  tabs: PlusSquareOutlined,
  details: UnorderedListOutlined,
  shield: SafetyOutlined,
  audit: AuditOutlined,
  attachment: PaperClipOutlined,
} satisfies Record<string, ComponentType<{ className?: string; style?: CSSProperties; 'aria-hidden'?: boolean }>>

export function Icon({ name, size = 18, className = '', style }: { name: keyof typeof icons; size?: number; className?: string; style?: CSSProperties }) {
  const Component = icons[name]
  return <Component aria-hidden={true} className={`pulse-icon ${className}`.trim()} style={{ fontSize: size, ...style }} />
}
