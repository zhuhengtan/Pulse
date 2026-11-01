import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
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
      colorPrimary: dark ? '#dedede' : '#292929',
      colorInfo: dark ? '#bdbdbd' : '#555555',
      colorSuccess: '#16865d',
      colorWarning: '#d28b19',
      colorError: '#d84c4c',
      colorBgBase: dark ? '#181818' : '#ffffff',
      colorBgContainer: dark ? '#202020' : '#ffffff',
      colorBgElevated: dark ? '#242424' : '#ffffff',
      colorBorder: dark ? '#383838' : '#e5e5e5',
      colorText: dark ? '#ededed' : '#202020',
      colorTextSecondary: dark ? '#a3a3a3' : '#707070',
      colorTextLightSolid: dark ? '#181818' : '#ffffff',
      borderRadius: 10,
      borderRadiusLG: 14,
      controlHeight: 40,
      controlHeightLG: 44,
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 13,
    },
    components: {
      Button: { borderRadius: 9, controlHeight: 38, fontWeight: 550, paddingInline: 12, primaryColor: dark ? '#181818' : '#ffffff', dangerColor: '#ffffff' },
      Input: { controlHeight: 42, activeShadow: '0 0 0 3px rgba(127,127,127,.12)' },
      InputNumber: { controlHeight: 42, activeShadow: '0 0 0 3px rgba(127,127,127,.12)' },
      Select: { controlHeight: 42, optionSelectedBg: dark ? '#353535' : '#eeeeee' },
      Tabs: { itemSelectedColor: dark ? '#ededed' : '#202020', itemActiveColor: dark ? '#ededed' : '#202020', inkBarColor: dark ? '#ededed' : '#202020' },
      Card: { borderRadiusLG: 14 },
      Menu: { itemBorderRadius: 8, itemHeight: 42 },
      Modal: { borderRadiusLG: 16 },
    },
  }), [dark])

  return <StyleProvider layer><ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}>
    <AntdApp className="pulse-ant-app">{children}</AntdApp>
  </ConfigProvider></StyleProvider>
}
