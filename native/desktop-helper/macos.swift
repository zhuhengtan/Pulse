import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Darwin

struct DesktopFailure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw DesktopFailure(message: message) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

@main struct Desktop {
    static var displayID: CGDirectDisplayID = CGMainDisplayID()
    static var window: AXUIElement?
    static var elements: [String: AXUIElement] = [:]
    static var heldKeys: [CGKeyCode] = []
    static var mouseDown = false
    static var bounds: CGRect { CGDisplayBounds(displayID) }
    static var geometry: String { "\(displayID):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)" }
    static let keys: [String: CGKeyCode] = ["Enter":36,"Return":36,"Tab":48,"Space":49,"Backspace":51,"Escape":53,"Delete":117,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,"Home":115,"End":119,"PageUp":116,"PageDown":121,"Meta":55,"Command":55,"Control":59,"Ctrl":59,"Alt":58,"Option":58,"Shift":56,"a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46]
    static func release() {
        for key in heldKeys.reversed() { CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap) }
        heldKeys = []
        if mouseDown { CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: CGEvent(source:nil)?.location ?? .zero, mouseButton: .left)?.post(tap: .cghidEventTap) }
        mouseDown = false
    }
    static func point(_ value: Any?) throws -> CGPoint {
        guard let value = value as? [String:Double], let x=value["x"], let y=value["y"], x >= 0, x <= 1, y >= 0, y <= 1 else { try fail("INVALID_POINT") }
        return CGPoint(x:bounds.minX+x*(bounds.width-1),y:bounds.minY+y*(bounds.height-1))
    }
    static func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, _ count: Int64 = 1) {
        let event = CGEvent(mouseEventSource:nil, mouseType:type, mouseCursorPosition:point, mouseButton:button)
        event?.setIntegerValueField(.mouseEventClickState,value:count); event?.post(tap:.cghidEventTap)
    }
    @MainActor static func snapshot() async throws -> [String:Any] {
        guard CGPreflightScreenCaptureAccess() else { try fail("SCREEN_RECORDING_PERMISSION_REQUIRED") }
        let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
        guard let display = content.displays.first(where: {$0.displayID == displayID}) else { try fail("DISPLAY_NOT_AVAILABLE") }
        let configuration = SCStreamConfiguration()
        let scale = min(1.0,1600.0/max(Double(display.width),Double(display.height)))
        configuration.width = max(1,Int(Double(display.width)*scale)); configuration.height = max(1,Int(Double(display.height)*scale)); configuration.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display:display,excludingWindows:[]),configuration:configuration)
        let bitmap = NSBitmapImageRep(cgImage:image)
        guard let data=bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.75]) else { try fail("SCREENSHOT_ENCODING_FAILED") }
        elements = [:]
        var lines: [String] = []
        let application = NSWorkspace.shared.frontmostApplication
        if AXIsProcessTrusted(), let app=application {
            let root = window ?? AXUIElementCreateApplication(app.processIdentifier)
            func walk(_ element: AXUIElement, _ depth:Int) {
                if depth > 8 || elements.count >= 250 { return }
                let id="e\(elements.count)"; elements[id]=element
                let role=attr(element,kAXRoleAttribute) as? String ?? ""
                let title=attr(element,kAXTitleAttribute) as? String ?? ""
                let protected = (attr(element,kAXSubroleAttribute) as? String) == kAXSecureTextFieldSubrole
                let value=protected ? "[protected]" : (attr(element,kAXValueAttribute) as? String ?? "")
                lines.append("[\(id)] \(role) \(title.prefix(120)) \(value.prefix(120))")
                for child in attr(element,kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child,depth+1) }
            }
            walk(root,0)
        }
        return ["width":image.width,"height":image.height,"geometry":geometry,"title":application?.localizedName ?? "Desktop","text":lines.joined(separator:"\n"),"image":["mediaType":"image/jpeg","data":data.base64EncodedString()]]
    }
    @MainActor static func call(_ method:String,_ params:[String:Any]) async throws -> Any {
        if let id=params["displayId"] as? String, let value=UInt32(id) { displayID=value }
        switch method {
        case "requestPermissions":
            let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            var capture = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
            var requestError = ""
            if !capture {
                // Register a real ScreenCaptureKit content request too. Some
                // macOS versions return false from the legacy CG request
                // without presenting a consent dialog or adding a settings row.
                do { _ = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true) }
                catch { requestError = String(describing:error) }
                capture = CGPreflightScreenCaptureAccess()
            }
            return ["accessibility":trusted,"screenCapture":capture,"screenCaptureRequestError":requestError]
        case "hello", "doctor": return ["protocolVersion":1,"platform":"darwin","permissionApplication":Bundle.main.object(forInfoDictionaryKey:"CFBundleDisplayName") as? String ?? "unknown","bundleIdentifier":Bundle.main.bundleIdentifier ?? "unknown","pid":getpid(),"parentPid":getppid(),"screenCapture":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),"input":AXIsProcessTrusted()]
        case "displays":
            var ids=[CGDirectDisplayID](repeating:0,count:32); var count:UInt32=0
            CGGetActiveDisplayList(32,&ids,&count)
            return ids.prefix(Int(count)).map { ["id":String($0),"x":CGDisplayBounds($0).minX,"y":CGDisplayBounds($0).minY,"width":CGDisplayBounds($0).width,"height":CGDisplayBounds($0).height] as [String:Any] }
        case "windows":
            guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
            return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.flatMap { app in
                let windows=attr(AXUIElementCreateApplication(app.processIdentifier),kAXWindowsAttribute) as? [AXUIElement] ?? []
                return windows.enumerated().map { index,element in ["id":"\(app.processIdentifier):\(index)","title":(attr(element,kAXTitleAttribute) as? String) ?? app.localizedName ?? ""] }
            }
        case "selectWindow":
            guard let id=params["windowId"] as? String,let pid=Int32(id.split(separator:":").first ?? ""), let app=NSRunningApplication(processIdentifier:pid) else { try fail("WINDOW_NOT_FOUND") }
            guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
            let list=attr(AXUIElementCreateApplication(pid),kAXWindowsAttribute) as? [AXUIElement] ?? []
            guard let index=Int(id.split(separator:":").last ?? ""),index>=0,index<list.count else { try fail("WINDOW_NOT_FOUND") }
            app.activate(options:[]);window=list[index]
            guard AXUIElementPerformAction(list[index],kAXRaiseAction as CFString) == .success else { try fail("WINDOW_FOCUS_DENIED") }
            return ["selected":true]
        case "observe": return try await snapshot()
        case "release": release(); return ["released":true]
        case "act":
            guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
            guard params["geometry"] as? String == geometry, let action=params["action"] as? [String:Any],let type=action["type"] as? String else { try fail("STALE_GEOMETRY") }
            defer { release() }
            switch type {
            case "element":
                guard let ref=action["ref"] as? String, let element=elements[ref] else { try fail("STALE_ELEMENT") }
                let result:AXError
                if action["operation"] as? String == "click" { result=AXUIElementPerformAction(element,kAXPressAction as CFString) }
                else { result=AXUIElementSetAttributeValue(element,kAXValueAttribute as CFString,(action["value"] as? String ?? "") as CFString) }
                guard result == .success else { try fail("ELEMENT_OPERATION_UNSUPPORTED") }
            case "click":
                let p=try point(action["point"]), right=action["button"] as? String == "right"
                for count in 1...(action["count"] as? Int ?? 1) { mouse(right ? .rightMouseDown:.leftMouseDown,p,right ? .right:.left,Int64(count)); mouse(right ? .rightMouseUp:.leftMouseUp,p,right ? .right:.left,Int64(count)) }
            case "drag":
                let from=try point(action["from"]),to=try point(action["to"])
                mouse(.leftMouseDown,from); mouseDown=true
                for i in 1...20 { mouse(.leftMouseDragged,CGPoint(x:from.x+(to.x-from.x)*Double(i)/20,y:from.y+(to.y-from.y)*Double(i)/20)); try await Task.sleep(nanoseconds:10_000_000) }
                mouse(.leftMouseUp,to); mouseDown=false
            case "scroll":
                mouse(.mouseMoved,try point(action["point"]))
                CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(-(action["dy"] as? Int ?? 0)),wheel2:Int32(-(action["dx"] as? Int ?? 0)),wheel3:0)?.post(tap:.cghidEventTap)
            case "type":
                let chars=Array((action["text"] as? String ?? "").utf16)
                for chunk in stride(from:0,to:chars.count,by:20) {
                    let part=Array(chars[chunk..<min(chunk+20,chars.count)])
                    let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)
                    down?.keyboardSetUnicodeString(stringLength:part.count,unicodeString:part); up?.keyboardSetUnicodeString(stringLength:part.count,unicodeString:part)
                    down?.post(tap:.cghidEventTap); up?.post(tap:.cghidEventTap)
                }
            case "key":
                var flags:CGEventFlags=[]
                for name in action["keys"] as? [String] ?? [] {
                    guard let key=keys[name] ?? keys[name.lowercased()] else { try fail("UNSUPPORTED_KEY") }
                    if ["Meta","Command"].contains(name) { flags.insert(.maskCommand) }; if ["Control","Ctrl"].contains(name) { flags.insert(.maskControl) }; if ["Alt","Option"].contains(name) { flags.insert(.maskAlternate) }; if name == "Shift" { flags.insert(.maskShift) }
                    heldKeys.append(key); let event=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:true); event?.flags=flags; event?.post(tap:.cghidEventTap)
                }
            default: try fail("UNSUPPORTED_ACTION")
            }
            elements=[:]; return ["applied":true]
        default: try fail("UNKNOWN_METHOD")
        }
    }
    @MainActor static func respond(_ line:String) async {
        var id:Any=NSNull()
        do {
            guard line.utf8.count <= 65536,let data=line.data(using:.utf8),let request=try JSONSerialization.jsonObject(with:data) as? [String:Any],let method=request["method"] as? String else { try fail("INVALID_REQUEST") }
            id=request["id"] ?? NSNull()
            let result=try await call(method,request["params"] as? [String:Any] ?? [:])
            let encoded=try JSONSerialization.data(withJSONObject:["jsonrpc":"2.0","id":id,"result":result],options:[.sortedKeys]); print(String(data:encoded,encoding:.utf8)!); fflush(stdout)
        } catch { release(); let message=(error as? DesktopFailure)?.message ?? String(describing:error); if let encoded=try? JSONSerialization.data(withJSONObject:["jsonrpc":"2.0","id":id,"error":["message":message]]) { print(String(data:encoded,encoding:.utf8)!); fflush(stdout) } }
    }
    @MainActor static func main() {
        // Launch Services starts this app independently. The private socket is
        // created by the Rust supervisor; never fall back to inherited stdio.
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--socket" else { return }
        let path=CommandLine.arguments[2]
        var address=sockaddr_un()
        address.sun_family=sa_family_t(AF_UNIX)
        let bytes=Array(path.utf8)+[0]
        guard bytes.count <= MemoryLayout.size(ofValue:address.sun_path) else { return }
        withUnsafeMutableBytes(of:&address.sun_path) { target in target.copyBytes(from:bytes) }
        address.sun_len=UInt8(MemoryLayout<sockaddr_un>.size)
        let fd=socket(AF_UNIX,SOCK_STREAM,0)
        guard fd >= 0 else { return }
        let connected=withUnsafePointer(to:&address) { pointer in pointer.withMemoryRebound(to:sockaddr.self,capacity:1) { Darwin.connect(fd,$0,socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard connected == 0 else { Darwin.close(fd);return }
        dup2(fd,STDIN_FILENO);dup2(fd,STDOUT_FILENO);Darwin.close(fd)
        signal(SIGPIPE,SIG_IGN)
        let application=NSApplication.shared
        application.setActivationPolicy(.accessory)
        // Keep AppKit's normal application lifecycle/run loop alive while RPC
        // stdin waits on a background thread, so system consent UI can run.
        DispatchQueue.global().async {
            while let line=readLine() {
                let done=DispatchSemaphore(value:0)
                Task { @MainActor in await respond(line);done.signal() }
                done.wait()
            }
            DispatchQueue.main.async { release();NSApplication.shared.terminate(nil) }
        }
        application.run()
    }
}
