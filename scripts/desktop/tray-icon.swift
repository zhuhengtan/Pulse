import AppKit
import ImageIO
let args = CommandLine.arguments
let source = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2])
guard let input = CGImageSourceCreateWithURL(source as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(input, 0, nil) else { fatalError("BRAND_IMAGE_REQUIRED") }
let w = image.width, h = image.height
var rgba = [UInt8](repeating: 0, count: w*h*4)
let space = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
// Preserve every source alpha value: the Pulse mark has separate intentional strokes.
// Keeping only one connected component removes the inner stroke and changes the brand.
var mask = [UInt8](repeating: 0, count: w*h*4)
var x0 = w, y0 = h, x1 = 0, y1 = 0
for p in 0..<(w*h) {
 let alpha = rgba[p*4+3]
 mask[p*4+3] = alpha
 if alpha >= 128 { x0 = min(x0,p%w); x1 = max(x1,p%w); y0 = min(y0,p/w); y1 = max(y1,p/w) }
}
precondition(x0 <= x1 && y0 <= y1)
let maskContext = CGContext(data: &mask, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let cropped = maskContext.makeImage()!.cropping(to: CGRect(x:x0,y:y0,width:x1-x0+1,height:y1-y0+1))!
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for scale in [1,2] {
 let size = 18*scale, inset = CGFloat(scale), available = CGFloat(16*scale)
 let ratio = min(available/CGFloat(cropped.width), available/CGFloat(cropped.height))
 let dw = CGFloat(cropped.width)*ratio, dh = CGFloat(cropped.height)*ratio
 let result = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size*4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
 result.interpolationQuality = .high
 result.draw(cropped, in: CGRect(x:max(inset,(CGFloat(size)-dw)/2),y:max(inset,(CGFloat(size)-dh)/2),width:dw,height:dh))
 let bitmap = NSBitmapImageRep(cgImage: result.makeImage()!)
 let name = scale == 1 ? "trayTemplate.png" : "trayTemplate@2x.png"
 try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
}
print("Generated transparent Pulse mark at 18pt / 36px")
