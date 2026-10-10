/**
 * `osReleaseId` is the `ID=` value from /etc/os-release; it only matters on Linux.
 */
export function installHint(platform: NodeJS.Platform, osReleaseId?: string): string {
  switch (platform) {
    case "darwin":
      return "brew install ffmpeg";
    case "win32":
      return "winget install ffmpeg";
    default:
      switch (osReleaseId) {
        case "fedora":
        case "rhel":
        case "centos":
          return "sudo dnf install ffmpeg";
        case "arch":
        case "manjaro":
          return "sudo pacman -S ffmpeg";
        case "alpine":
          return "sudo apk add ffmpeg";
        default:
          return "sudo apt install ffmpeg";
      }
  }
}
