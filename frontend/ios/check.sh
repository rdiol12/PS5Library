#!/bin/sh
set -eu
cd "$(dirname "$0")"
checks=$(mktemp -d)
trap 'rm -rf "$checks"' EXIT
grep -q '"/api/v1/service-info"' PS5LibraryCompanion/API.swift
grep -q '^import AVFoundation$' PS5LibraryCompanion/PairingScanner.swift
grep -q '^actor API' PS5LibraryCompanion/API.swift
grep -q '^@MainActor final class Store' PS5LibraryCompanion/Store.swift
! grep -q 'masterUrl' PS5LibraryCompanion/*.swift
! grep -q 'Master' PS5LibraryCompanion/*.swift
grep -q 'This companion only contacts the Library Node' PS5LibraryCompanion/*.swift
test "$(grep -h -c '\.tabItem' PS5LibraryCompanion/*.swift | awk '{ total += $1 } END { print total }')" -eq 4
! grep -q 'Label("Discover"' PS5LibraryCompanion/*.swift
grep -q 'Picker("Location"' PS5LibraryCompanion/*.swift
grep -q 'struct LibraryGameRow' PS5LibraryCompanion/*.swift
grep -q 'private struct LibraryStage' PS5LibraryCompanion/*.swift
grep -q 'var contentMode:ContentMode = .fill' PS5LibraryCompanion/*.swift
test "$(grep -h -c 'ArtworkView(path:game.heroUrl,contentMode:.fit)' PS5LibraryCompanion/*.swift | awk '{ total += $1 } END { print total }')" -eq 2
grep -q 'NavigationStack{ProfileView()}.tabItem' PS5LibraryCompanion/*.swift
grep -q 'TAILSCALE FALLBACK (OPTIONAL)' PS5LibraryCompanion/*.swift
grep -Eq 'serverTransportFailure\(error\),[[:space:]]*let fallback' PS5LibraryCompanion/API.swift
grep -q 'let operation: BuildByteProgress?' PS5LibraryCompanion/Models.swift
test "$(grep -c 'INFOPLIST_FILE = PS5LibraryCompanion/Info.plist' PS5LibraryCompanion.xcodeproj/project.pbxproj)" -eq 2
! grep -q 'INFOPLIST_KEY_NSAppTransportSecurity' PS5LibraryCompanion.xcodeproj/project.pbxproj
grep -q '<key>NSAllowsLocalNetworking</key>' PS5LibraryCompanion/Info.plist
grep -q '<key>100.64.0.0/10</key>' PS5LibraryCompanion/Info.plist
grep -q '<key>NSExceptionAllowsInsecureHTTPLoads</key>' PS5LibraryCompanion/Info.plist
! grep -q '<key>NSAllowsArbitraryLoads</key>' PS5LibraryCompanion/Info.plist
! grep -Eq '&&!|==\.' PS5LibraryCompanion/*.swift
for source in PS5LibraryCompanion/*.swift; do
  grep -q "path = $(basename "$source")" PS5LibraryCompanion.xcodeproj/project.pbxproj
done
if command -v swiftc >/dev/null 2>&1; then
  swiftc PS5LibraryCompanion/Models.swift PS5LibraryCompanion/CommunityModels.swift Checks/main.swift -o "$checks/models"
  "$checks/models"
  swiftc -frontend -parse PS5LibraryCompanion/*.swift
else
  echo "swiftc unavailable; static iOS checks passed"
fi
