import type { SVGProps } from "react";

export type DockerIconProps = {
  size?: number;
  className?: string;
};

function Icon({
  size = 14,
  className,
  children,
}: DockerIconProps & { children: SVGProps<SVGSVGElement>["children"] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Stacked containers — header / brand mark */
export function DockerLogoIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <rect x="3" y="9" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="5" y="4" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="14" width="10" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </Icon>
  );
}

export function ContainersIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <rect x="4" y="7" width="16" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 10h16" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Icon>
  );
}

export function ComposeIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <path
        d="M12 3L3 8l9 5 9-5-9-5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3 12l9 5 9-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M3 17l9 5 9-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </Icon>
  );
}

export function VolumesIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function NetworksIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 12h18" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function ImagesIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <rect x="3" y="5" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="9" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </Icon>
  );
}

export function LogsIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <path
        d="M7 3h7l5 5v13H7V3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 13h8M10 17h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Icon>
  );
}

export function SystemIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <rect x="4" y="3" width="16" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="11" width="16" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="6" r="1" fill="currentColor" />
      <circle cx="8" cy="14" r="1" fill="currentColor" />
      <path d="M12 6h5M12 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Icon>
  );
}

export function FolderIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <path
        d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

export function FileIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <path
        d="M7 3h7l5 5v13H7V3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </Icon>
  );
}

export function YamlFileIcon({ size, className }: DockerIconProps) {
  return (
    <Icon size={size} className={className}>
      <path
        d="M7 3h7l5 5v13H7V3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 14h6M10 17h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Icon>
  );
}
