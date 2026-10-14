import SwiftUI
import VisionKit
import UIKit
import AVFoundation

struct PairingScannerSheet: View {
    @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) var phase
    let received: (String) -> Void
    @State private var ready = false
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if let failure = failure {
                    ContentUnavailableView(
                        "Camera unavailable",
                        systemImage: "camera",
                        description: Text(failure)
                    )
                    Button("Enter code manually") {
                        dismiss()
                    }
                } else if ready && phase == .active {
                    PairingCamera(received: received, failed: {
                        failure = $0
                    })
                    .accessibilityLabel(
                        "Point the camera at the pairing QR code displayed on your PS5"
                    )
                } else {
                    ProgressView("Preparing camera...")
                }
                Text(
                    "Scan the pairing QR code shown by PS5Library. You can review the console selection before linking."
                )
                .font(.footnote).padding()
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(CinematicBackdrop())
                .navigationTitle("Scan Pairing Code").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }
                }
        }.task {
            guard DataScannerViewController.isSupported else {
                failure = "QR scanning is not supported on this device. Use the displayed pairing code."
                return
            }
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            guard !Task.isCancelled else {
                return
            }
            guard allowed else {
                failure = "Allow camera access in iPhone Settings, or enter the pairing code manually."
                return
            }
            guard DataScannerViewController.isAvailable else {
                failure = "The camera is unavailable or restricted. Enter the code manually."
                return
            }
            ready = true
        }
    }
}

struct PairingCamera: UIViewControllerRepresentable {
    let received: (String) -> Void
    let failed: (String) -> Void
    func makeUIViewController(context: Context) -> PairingCameraController {
        PairingCameraController(received: received, failed: failed)
    }

    func updateUIViewController(_ controller: PairingCameraController, context: Context) {}
    static func dismantleUIViewController(_ controller: PairingCameraController, coordinator: ()) {
        controller.scanner.stopScanning()
    }
}

final class PairingCameraController: UIViewController, DataScannerViewControllerDelegate {
    let scanner = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])],
        recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false,
        isHighlightingEnabled: true
    )
    let received: (String) -> Void
    let failed: (String) -> Void
    private var consumed = false
    init(received: @escaping (String) -> Void, failed: @escaping (String) -> Void) {
        self.received = received
        self.failed = failed
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("Use the programmatic initializer")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        scanner.delegate = self
        addChild(scanner)
        view.addSubview(scanner.view)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scanner.view.topAnchor.constraint(equalTo: view.topAnchor),
            scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        scanner.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !consumed else {
            return
        }
        do {
            try scanner.startScanning()
        } catch {
            failed("Could not start the camera. Try again or enter the pairing code manually.")
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        scanner.stopScanning()
        super.viewWillDisappear(animated)
    }

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        didAdd addedItems: [RecognizedItem],
        allItems: [RecognizedItem]
    ) {
        accept(addedItems)
    }

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        didUpdate updatedItems: [RecognizedItem],
        allItems: [RecognizedItem]
    ) {
        accept(updatedItems)
    }

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
    ) {
        scanner.stopScanning()
        failed("Camera scanning became unavailable. Try again or enter the pairing code manually.")
    }

    private func accept(_ items: [RecognizedItem]) {
        guard !consumed else {
            return
        }
        for item in items {
            if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                consumed = true
                scanner.stopScanning()
                received(payload)
                return
            }
        }
    }
}
