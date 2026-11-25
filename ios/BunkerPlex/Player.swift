import AVKit
import UIKit

/// I video dei PC raggiunti da fuori casa (remote.html): li apre il player di
/// iOS, con AirPlay e picture-in-picture. Il PC li converte in HLS
/// (/api/share/hls), l'unico flusso che AVPlayer legge mentre viene creato.
enum Player {
    static func play(from host: UIViewController, base: String, json: String) {
        let p = Remote.parse(json)
        let url = p["url"] as? String ?? ""
        guard let r = url.range(of: "/api/share/stream/"),
              let id = Int(url[r.upperBound...].prefix { $0.isNumber }) else { return }
        let root = String(url[..<r.lowerBound])
        let tok = String((0..<16).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
        let height = p["remote_height"] as? Int ?? 720
        guard let hls = URL(string: "\(root)/api/share/hls/\(id)/\(tok)-1/index.m3u8?height=\(height)") else { return }

        let item = AVPlayerItem(url: hls)
        var meta: [AVMetadataItem] = []
        if let title = p["title"] as? String {
            let m = AVMutableMetadataItem()
            m.identifier = .commonIdentifierTitle
            m.value = title as NSString
            m.extendedLanguageTag = "und"
            meta.append(m)
        }
        item.externalMetadata = meta
        let vc = AVPlayerViewController()
        vc.player = AVPlayer(playerItem: item)
        vc.allowsPictureInPicturePlayback = true
        vc.modalPresentationStyle = .fullScreen
        host.present(vc, animated: true) { vc.player?.play() }
    }
}
