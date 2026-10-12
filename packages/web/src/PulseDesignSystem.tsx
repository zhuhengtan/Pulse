import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

function prefersDarkTheme(): boolean {
  const setting = document.documentElement.dataset.theme ?? 'system'
  return setting === 'dark' || (setting === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function PulseDesignSystem({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(prefersDarkTheme)
  useEffect(() => {
    const sync = () => setDark(prefersDarkTheme())
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', sync)
    return () => { observer.disconnect(); media.removeEventListener('change', sync) }
  }, [])

  const theme = useMemo(() => ({
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: '#4263eb',
      colorInfo: '#4263eb',
      colorSuccess: '#16865d',
      colorWarning: '#d28b19',
      colorError: '#d84c4c',
      colorBgBase: dark ? '#1b1d21' : '#ffffff',
      colorBgContainer: dark ? '#1f2228' : '#ffffff',
      colorBgElevated: dark ? '#252830' : '#ffffff',
      colorBorder: dark ? '#353942' : '#e4e7ec',
      colorText: dark ? '#e8eaee' : '#252a33',
      colorTextSecondary: dark ? '#a5abb5' : '#747b87',
      borderRadius: 10,
      borderRadiusLG: 14,
      controlHeight: 40,
      controlHeightLG: 44,
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 13,
    },
    components: {
      Button: { borderRadius: 9, controlHeight: 38, fontWeight: 550, paddingInline: 12 },
      Input: { controlHeight: 42, activeShadow: '0 0 0 3px rgba(66,99,235,.12)' },
      InputNumber: { controlHeight: 42, activeShadow: '0 0 0 3px rgba(66,99,235,.12)' },
      Select: { controlHeight: 42, optionSelectedBg: dark ? '#30384d' : '#eef2ff' },
      Card: { borderRadiusLG: 14 },
      Menu: { itemBorderRadius: 8, itemHeight: 42 },
      Modal: { borderRadiusLG: 16 },
    },
  }), [dark])

  return <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}>
    <AntdApp className="pulse-ant-app">{children}</AntdApp>
  </ConfigProvider>
}
