import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    let root: URL
    let window = NSWindow(contentRect: NSRect(x:0,y:0,width:640,height:260), styleMask:[.titled,.closable], backing:.buffered, defer:false)
    let field = NSTextField(frame:NSRect(x:40,y:145,width:560,height:32))
    let button = NSButton(frame:NSRect(x:40,y:70,width:160,height:40))
    let slider = NSSlider(value:0,minValue:0,maxValue:1,target:nil,action:nil)
    init(root:URL) { self.root=root;super.init() }
    func applicationDidFinishLaunching(_ notification:Notification) {
        window.title="Pulse Desktop Acceptance"
        // Use the primary display explicitly; NSScreen.main follows the
        // active window and can otherwise choose another connected monitor.
        window.setFrameOrigin(NSPoint(x:NSScreen.screens[0].frame.minX+80,y:NSScreen.screens[0].frame.minY+80))
        field.placeholderString="Pulse acceptance text"
        field.setAccessibilityLabel("Acceptance text")
        button.title="Save acceptance"
        button.target=self;button.action=#selector(save)
        slider.frame=NSRect(x:260,y:75,width:340,height:30)
        window.contentView?.addSubview(field)
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(slider)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps:true)
        func point(_ view:NSView,_ fraction:Double=0.5)->[String:Double] {
            let p=window.convertPoint(toScreen:view.convert(NSPoint(x:view.bounds.width*fraction,y:view.bounds.midY),to:nil))
            return ["x":p.x,"y":NSScreen.screens[0].frame.maxY-p.y]
        }
        let metadata:[String:Any]=["pid":ProcessInfo.processInfo.processIdentifier,"field":point(field),"save":point(button),"dragFrom":point(slider,0.02),"dragTo":point(slider,0.95)]
        try! JSONSerialization.data(withJSONObject:metadata).write(to:root.appendingPathComponent("ready.json"),options:.atomic)
    }
    @objc func save() {
        try! field.stringValue.write(to:root.appendingPathComponent("result.txt"),atomically:true,encoding:.utf8)
        try! String(slider.doubleValue).write(to:root.appendingPathComponent("slider.txt"),atomically:true,encoding:.utf8)
        button.title="Saved acceptance"
    }
}

let app=NSApplication.shared
app.setActivationPolicy(.regular)
let fixture=Fixture(root:URL(fileURLWithPath:CommandLine.arguments[1]))
app.delegate=fixture
app.run()
