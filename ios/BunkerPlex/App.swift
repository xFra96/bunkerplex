import AVFoundation
import UIKit

/// L'app BunkerPlex per iPhone e iPad: mostra l'interfaccia del server di casa
/// (la stessa del browser, con i video in HLS) e, fuori casa, la pagina degli
/// amici e dei tuoi PC raggiunti con il Tailscale dentro l'app (libreria Bpnet).
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Audio anche col telefono in silenzioso, AirPlay e picture-in-picture
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = Theme.background
        w.rootViewController = MainController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}

enum Theme {
    static let background = UIColor(red: 6 / 255, green: 10 / 255, blue: 7 / 255, alpha: 1)
}
