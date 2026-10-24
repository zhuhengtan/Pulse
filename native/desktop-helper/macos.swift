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

#if !PULSE_DESKTOP_TEST
@main
#endif
struct Desktop {
    static var displayID: CGDirectDisplayID = CGMainDisplayID()
    static var window: AXUIElement?
    static var selectedWindowID: String?
    static var selectedPID: pid_t?
    static var selectedCaptureID: CGWindowID?
    static var selectedCaptureBounds: CGRect?
    struct CaptureTarget { let pid: pid_t; let id: CGWindowID }
    static var windowTargets: [String:CaptureTarget] = [:]
    static var elements: [String: AXUIElement] = [:]
    static var heldKeys: [CGKeyCode] = []
    static var mouseDown = false
    static func applicationElement(_ pid:pid_t) -> AXUIElement {
        let application=AXUIElementCreateApplication(pid)
        // Chromium may omit its windows after a renderer reload until AX is
        // explicitly enabled. Opt in before querying windows, without focusing.
        AXUIElementSetAttributeValue(application,"AXManualAccessibility" as CFString,kCFBooleanTrue)
        AXUIElementSetAttributeValue(application,"AXEnhancedUserInterface" as CFString,kCFBooleanTrue)
        return application
    }
    static func windowBounds(_ element: AXUIElement) -> CGRect? {
        guard let p = attr(element,kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = attr(element,kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var position = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(p,to:AXValue.self),.cgPoint,&position), AXValueGetValue(unsafeBitCast(s,to:AXValue.self),.cgSize,&size), size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin:position,size:size)
    }
    static var bounds: CGRect { window.flatMap(windowBounds) ?? selectedCaptureBounds ?? CGDisplayBounds(displayID) }
    static func mapPoint(_ x: Double,_ y: Double,_ area: CGRect) throws -> CGPoint {
        guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y), area.width > 0, area.height > 0 else { try fail("INVALID_POINT") }
        return CGPoint(x:area.minX+x*(area.width-1),y:area.minY+y*(area.height-1))
    }
    static func matchingWindow(_ frames: [(pid_t, CGRect)],_ pid:pid_t,_ target:CGRect) -> Int? {
        let matches=frames.indices.filter { i in let value=frames[i]; return value.0 == pid && abs(value.1.minX-target.minX)<2 && abs(value.1.minY-target.minY)<2 && abs(value.1.width-target.width)<2 && abs(value.1.height-target.height)<2 }
        return matches.count == 1 ? matches[0] : nil
    }
    static func matchingCaptureWindow(_ identities: [(pid_t, CGWindowID)],_ pid:pid_t,_ id:CGWindowID) -> Int? {
        let matches=identities.indices.filter { identities[$0].0 == pid && identities[$0].1 == id }
        return matches.count == 1 ? matches[0] : nil
    }
    static func axLine(_ id:String,_ role:String,_ name:String,_ value:String,_ states:[String],_ secure:Bool) -> String {
        "[\(id)] \(role) \(name.prefix(300)) value=\(secure ? "[protected]" : String(value.prefix(300))) \(states.joined(separator:" "))"
    }
    static var geometry: String { "\(displayID):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(selectedPID ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0):\(selectedWindowID ?? "display")" }
    static let keys: [String: CGKeyCode] = ["Enter":36,"Return":36,"Tab":48,"Space":49,"Backspace":51,"Escape":53,"Delete":117,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,"Home":115,"End":119,"PageUp":116,"PageDown":121,"Meta":55,"Command":55,"Control":59,"Ctrl":59,"Alt":58,"Option":58,"Shift":56,"a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46]
    static func release() {
        for key in heldKeys.reversed() { CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap) }
        heldKeys = []
        if mouseDown { CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: CGEvent(source:nil)?.location ?? .zero, mouseButton: .left)?.post(tap: .cghidEventTap) }
        mouseDown = false
    }
    static func point(_ value: Any?) throws -> CGPoint {
        guard let value = value as? [String:Double], let x=value["x"], let y=value["y"], x >= 0, x <= 1, y >= 0, y <= 1 else { try fail("INVALID_POINT") }
        return try mapPoint(x,y,bounds)
    }
    static func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, _ count: Int64 = 1) {
        let event = CGEvent(mouseEventSource:nil, mouseType:type, mouseCursorPosition:point, mouseButton:button)
        event?.setIntegerValueField(.mouseEventClickState,value:count); event?.post(tap:.cghidEventTap)
    }
    @MainActor static func snapshot() async throws -> [String:Any] {
        guard CGPreflightScreenCaptureAccess() else { try fail("SCREEN_RECORDING_PERMISSION_REQUIRED") }
        let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
        let filter: SCContentFilter
        let area: CGRect
        let title: String
        if let captureID=selectedCaptureID, let pid=selectedPID {
            guard let index=matchingCaptureWindow(content.windows.map { ($0.owningApplication?.processID ?? 0,$0.windowID) },pid,captureID) else { try fail("WINDOW_NOT_FOUND: selected capture window is no longer available") }
            let target=content.windows[index]
            if let selected=window,let rect=windowBounds(selected),matchingWindow([(pid,rect)],pid,target.frame) == nil { try fail("STALE_GEOMETRY") }
            filter=SCContentFilter(desktopIndependentWindow:target); area=target.frame
            title=target.title ?? ""
            selectedCaptureBounds=area
        } else if let selected=window, let pid=selectedPID {
            guard let rect=windowBounds(selected), let index=matchingWindow(content.windows.map { ($0.owningApplication?.processID ?? 0,$0.frame) },pid,rect) else { try fail("SELECTED_WINDOW_NOT_AVAILABLE") }
            let target=content.windows[index]
            filter=SCContentFilter(desktopIndependentWindow:target); area=rect
            title=(attr(selected,kAXTitleAttribute) as? String) ?? target.title ?? ""
        } else {
            guard let display=content.displays.first(where: {$0.displayID == displayID}) else { try fail("DISPLAY_NOT_AVAILABLE") }
            filter=SCContentFilter(display:display,excludingWindows:[]); area=CGDisplayBounds(displayID)
            title=NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop"
        }
        let before=geometry
        let configuration=SCStreamConfiguration()
        let scale=min(1.0,1600.0/max(Double(area.width),Double(area.height)))
        configuration.width=max(1,Int(Double(area.width)*scale)); configuration.height=max(1,Int(Double(area.height)*scale)); configuration.showsCursor=true
        let image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:configuration)
        guard before == geometry else { try fail("STALE_GEOMETRY") }
        let bitmap = NSBitmapImageRep(cgImage:image)
        guard let data=bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.75]) else { try fail("SCREENSHOT_ENCODING_FAILED") }
        elements = [:]
        var lines: [String] = []
        var accessibilityTruncated = false
        let application = NSWorkspace.shared.frontmostApplication
        if AXIsProcessTrusted(), let root=window ?? (selectedWindowID == nil ? application.map { AXUIElementCreateApplication($0.processIdentifier) } : nil) {
            func walk(_ element: AXUIElement, _ depth:Int) {
                if depth > 32 || elements.count >= 1000 { accessibilityTruncated = true; return }
                let id="e\(elements.count)"; elements[id]=element
                let role=attr(element,kAXRoleAttribute) as? String ?? ""
                let title=[kAXTitleAttribute,kAXDescriptionAttribute,kAXHelpAttribute,"AXPlaceholderValue"].compactMap { attr(element,$0) as? String }.first { !$0.isEmpty } ?? ""
                let protected = (attr(element,kAXSubroleAttribute) as? String) == kAXSecureTextFieldSubrole
                let raw=attr(element,kAXValueAttribute)
                let value=(raw as? String) ?? (raw as? NSNumber)?.stringValue ?? ""
                let states=[kAXEnabledAttribute,kAXSelectedAttribute,kAXExpandedAttribute].compactMap { key -> String? in
                    guard let state=attr(element,key) as? NSNumber else { return nil }; return "\(key)=\(state.boolValue)"
                }
                lines.append(axLine(id,role,title,value,states,protected))
                for child in attr(element,kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child,depth+1) }
            }
            walk(root,0)
        } else if selectedWindowID != nil {
            // A valid window image remains useful when Chromium's AX tree is
            // temporarily unavailable. Never substitute a background app tree.
            accessibilityTruncated = true
        }
        return ["width":image.width,"height":image.height,"geometry":before,"title":title,"text":lines.joined(separator:"\n"),"captureScope":selectedWindowID == nil ? "display" : "window","targetWindowId":selectedWindowID ?? "","captureBounds":["x":area.minX,"y":area.minY,"width":area.width,"height":area.height],"accessibilityTruncated":accessibilityTruncated,"image":["mediaType":"image/jpeg","data":data.base64EncodedString()]]
    }
    @MainActor static func resolveWindow(_ id:String) async throws -> (NSRunningApplication,AXUIElement?) {
        if id.hasPrefix("sc:"), let captureID=UInt32(id.dropFirst(3)) {
            let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
            guard let target=content.windows.first(where: { $0.windowID == captureID }),let pid=target.owningApplication?.processID,let app=NSRunningApplication(processIdentifier:pid),windowTargets[id]?.pid == pid else { try fail("WINDOW_NOT_FOUND: capture identity is absent or changed") }
            let list=attr(applicationElement(pid),kAXWindowsAttribute) as? [AXUIElement] ?? []
            let frames=list.map { (pid,windowBounds($0) ?? .zero) }
            let selected=matchingWindow(frames,pid,target.frame).map { list[$0] }
            window=selected;selectedWindowID=id;selectedPID=pid;selectedCaptureID=captureID;selectedCaptureBounds=target.frame
            return (app,selected)
        }
        // Restore older pid:index references through the original AX path.
        let parts=id.split(separator:":")
        guard parts.count == 2, let pid=Int32(parts[0]), let index=Int(parts[1]), let app=NSRunningApplication(processIdentifier:pid) else { try fail("WINDOW_NOT_FOUND") }
        guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
        let application=applicationElement(pid)
        let list=attr(application,kAXWindowsAttribute) as? [AXUIElement] ?? []
        guard index>=0,index<list.count else { try fail("WINDOW_NOT_FOUND") }
        window=list[index];selectedWindowID=id;selectedPID=pid;selectedCaptureID=nil;selectedCaptureBounds=nil
        return (app,list[index])
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
            let content=CGPreflightScreenCaptureAccess() ? try? await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false) : nil
            let captures=content?.windows ?? []
            var rows:[[String:String]]=[]
            var included=Set<CGWindowID>()
            var targets:[String:CaptureTarget]=[:]
            for app in NSWorkspace.shared.runningApplications.filter({ $0.activationPolicy == .regular }) {
                let windows=attr(applicationElement(app.processIdentifier),kAXWindowsAttribute) as? [AXUIElement] ?? []
                for (index,element) in windows.enumerated() {
                    var id="\(app.processIdentifier):\(index)"
                    if let rect=windowBounds(element),let match=matchingWindow(captures.map { ($0.owningApplication?.processID ?? 0,$0.frame) },app.processIdentifier,rect) {
                        let capture=captures[match];id="sc:\(capture.windowID)";included.insert(capture.windowID);targets[id]=CaptureTarget(pid:app.processIdentifier,id:capture.windowID)
                    }
                    rows.append(["id":id,"title":(attr(element,kAXTitleAttribute) as? String) ?? "","application":app.localizedName ?? "","bundleIdentifier":app.bundleIdentifier ?? ""])
                }
            }
            for capture in captures where !included.contains(capture.windowID) && capture.frame.width > 0 && capture.frame.height > 0 {
                guard let owner=capture.owningApplication,NSRunningApplication(processIdentifier:owner.processID)?.activationPolicy == .regular else { continue }
                let id="sc:\(capture.windowID)";targets[id]=CaptureTarget(pid:owner.processID,id:capture.windowID)
                rows.append(["id":id,"title":capture.title ?? "","application":owner.applicationName,"bundleIdentifier":owner.bundleIdentifier])
            }
            windowTargets=targets
            return rows
        case "selectWindow":
            guard let id=params["windowId"] as? String else { try fail("WINDOW_NOT_FOUND") }
            let (app,initial)=try await resolveWindow(id)
            app.activate(options:[])
            var selected=initial
            for _ in 0..<3 where selected == nil {
                try await Task.sleep(nanoseconds:100_000_000)
                selected=(try await resolveWindow(id)).1
            }
            guard let selected else { try fail("WINDOW_FOCUS_DENIED: exact accessibility target unavailable") }
            guard AXUIElementPerformAction(selected,kAXRaiseAction as CFString) == .success else { try fail("WINDOW_FOCUS_DENIED") }
            return ["selected":true]
        case "observe":
            if let id=params["windowId"] as? String { _ = try await resolveWindow(id) }
            return try await snapshot()
        case "release": release(); return ["released":true]
        case "act":
            guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
            guard params["geometry"] as? String == geometry, let action=params["action"] as? [String:Any],let type=action["type"] as? String else { try fail("STALE_GEOMETRY") }
            if let pid=selectedPID {
                guard let selected=window,NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                      let focused=attr(AXUIElementCreateApplication(pid),kAXFocusedWindowAttribute), CFEqual(focused,selected) else { try fail("SELECTED_WINDOW_NOT_FOCUSED") }
            }
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
