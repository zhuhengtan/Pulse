import Foundation

@main struct ContractChecks {
    static func main() throws {
        let bounds=CGRect(x:-500,y:200,width:400,height:300)
        let first=try Desktop.mapPoint(0,0,bounds); assert(first == CGPoint(x:-500,y:200))
        let last=try Desktop.mapPoint(1,1,bounds); assert(last == CGPoint(x:-101,y:499))
        do { _ = try Desktop.mapPoint(.nan,0,bounds); fatalError("NaN accepted") } catch {}
        do { _ = try Desktop.mapPoint(2,0,bounds); fatalError("Out of bounds accepted") } catch {}
        assert(Desktop.matchingWindow([(10,bounds),(20,bounds)],10,bounds) == 0)
        assert(Desktop.matchingWindow([(20,bounds)],10,bounds) == nil)
        assert(Desktop.matchingWindow([(10,bounds),(10,bounds)],10,bounds) == nil)
        assert(Desktop.matchingWindow([(10,CGRect(x:0,y:0,width:400,height:300))],10,bounds) == nil)
        assert(Desktop.matchingCaptureWindow([(10,100),(20,200)],10,100) == 0)
        assert(Desktop.matchingCaptureWindow([(20,100)],10,100) == nil)
        assert(Desktop.matchingCaptureWindow([(10,101)],10,100) == nil)
        assert(Desktop.matchingCaptureWindow([(10,100),(10,100)],10,100) == nil)
        assert(Desktop.axLine("e1","AXCheckBox","Summary","0",["AXEnabled=false"],false).contains("value=0 AXEnabled=false"))
        assert(!Desktop.axLine("e2","AXTextField","Password","secret",[],true).contains("secret"))
        assert(Desktop.axLine("e2","AXTextField","Password","secret",[],true).contains("[protected]"))
        print("native desktop contracts passed (15 checks)")
    }
}
