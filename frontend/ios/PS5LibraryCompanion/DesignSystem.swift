import SwiftUI
import UIKit


let accent = Color(red: 0.56, green: 0.78, blue: 1)
let appBackground = Color(red: 0.027, green: 0.043, blue: 0.067)
let raisedSurface = Color(red: 0.063, green: 0.102, blue: 0.157)
let secondaryText = Color(red: 0.73, green: 0.78, blue: 0.84)
let success = Color(red: 0.45, green: 0.84, blue: 0.68)
let warning = Color(red: 1, green: 0.74, blue: 0.36)
let danger = Color(red: 1, green: 0.51, blue: 0.47)

struct CinematicBackdrop: View {
    var body: some View {
        ZStack {
            appBackground
            LinearGradient(
                colors: [
                    Color(red: 0.035, green: 0.061, blue: 0.094),
                    appBackground,
                    .black.opacity(0.2)
                ],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )
        }.ignoresSafeArea()
    }
}

struct BrandMark: View {
    var compact = false
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "gamecontroller.fill").font(compact ? .title3 : .title)
                .foregroundStyle(.white)
                .frame(width: compact ? 34 : 44, height: compact ? 34 : 44).background(
                    accent.opacity(0.2),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            VStack(alignment: .leading, spacing: 0) {
                Text("PS5Library").font(compact ? .headline : .title2.bold())
                    .foregroundStyle(.white)
                if !compact {
                    Text("Games without limits").font(.caption).foregroundStyle(secondaryText)
                }
            }
        }.accessibilityElement(children: .combine)
    }
}

struct OfflineBanner: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "wifi.slash").font(.footnote.weight(.semibold))
            .foregroundStyle(warning)
            .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(
                warning.opacity(0.1),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(warning.opacity(0.25))
            }
    }
}

struct SectionHeading: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.title2.bold())
                Spacer()
                if let detail {
                    Text(detail).font(.caption.weight(.semibold)).foregroundStyle(secondaryText)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.title2.bold())
                if let detail {
                    Text(detail).font(.caption.weight(.semibold)).foregroundStyle(secondaryText)
                }
            }
        }
    }
}

struct StatusPill: View {
    let text: String
    var color: Color = accent
    var icon: String? = nil
    var body: some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
            }
            Text(text)
        }
        .font(.caption2.weight(.bold)).textCase(.uppercase).tracking(0.5).foregroundStyle(color)
        .padding(.horizontal, 9).frame(minHeight: 26).background(
            color.opacity(0.14),
            in: Capsule()
        )
    }
}

struct PressableCardStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.84 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.16),
                value: configuration.isPressed
            )
    }
}

extension View {
    func cinematicCard(padding: CGFloat = 16) -> some View {
        self.padding(padding).background(
            raisedSurface.opacity(0.88),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.white.opacity(0.08))
        }
    }

    func cinematicList() -> some View {
        self.scrollContentBackground(.hidden)
            .background(CinematicBackdrop())
    }
}

struct ArtworkView: View {
    @EnvironmentObject var store: Store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let path: String
    var contentMode:ContentMode = .fill
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [raisedSurface, appBackground],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: "gamecontroller.fill").font(.largeTitle)
                .foregroundStyle(accent.opacity(0.3))
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode).frame(
                    maxWidth: .infinity,
                    maxHeight: .infinity
                ).transition(.opacity)
            }
        }
        .clipped().allowsHitTesting(false).accessibilityHidden(true)
        .task(id: (store.account?.id ?? "") + path) {
            image = nil
            guard !path.isEmpty, let api = store.api else {
                return
            }
            do {
                let data = try await api.artwork(path)
                let decoded = await Task
                    .detached(priority: .utility) {
                        UIImage(data: data)?.preparingForDisplay()
                    }
                    .value
                if !Task
                    .isCancelled
                {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                        image = decoded
                    }
                }
            } catch {}
        }
    }
}
