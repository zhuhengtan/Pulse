import './brand.css'

const brandAssets = '/assets/brand/v1'

export function PulseBrand({ variant = 'logo' }: { variant?: 'logo' | 'mark' | 'app' }) {
  const logo = variant === 'logo'
  return <img
    className={`pulse-brand pulse-brand--${variant}`}
    src={`${brandAssets}/${logo ? 'pulse-logo.png' : variant === 'mark' ? 'pulse-mark.png' : 'icon-192.png'}`}
    alt={logo ? 'Pulse' : ''}
    aria-hidden={logo ? undefined : true}
    width={logo ? 96 : 48}
    height={logo ? 32 : 48}
    draggable={false}
  />
}
