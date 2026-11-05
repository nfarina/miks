// @chatwing
import WebKit

extension WKWebView {

    /// What the keyboard shows on top of it for the page's fields, in place of
    /// Safari's ‹ › Done bar (none, unless an app sets a bar of its own). Call
    /// reloadInputAccessoryView() for a change to show while it's up.
    public static var inputAccessory: UIView?

    /// Has the keyboard take inputAccessory again, while it's up.
    public func reloadInputAccessoryView() {
        // By kind, since removeInputAccessoryView swaps its class for a subclass.
        guard let contentClass = NSClassFromString("WKContentView") else { return }
        for view in scrollView.subviews where view.isKind(of: contentClass) {
            view.reloadInputViews()
        }
    }

    public func removeInputAccessoryView() {

        var targetView: UIView? = nil

        for view in self.scrollView.subviews {
            if String(describing: type(of: view)).hasPrefix("WKContent") {
                targetView = view
            }
        }

        if targetView == nil {
            return
        }

        let noInputAccessoryViewClassName = "\(targetView!.superclass!)_NoInputAccessoryView"
        var newClass : AnyClass? = NSClassFromString(noInputAccessoryViewClassName)
        if newClass == nil {
            let uiViewClass : AnyClass = object_getClass(targetView!)!
            newClass = objc_allocateClassPair(uiViewClass, noInputAccessoryViewClassName.cString(using: String.Encoding.ascii)!, 0)
            objc_registerClassPair(newClass!)
        }

        let originalMethod = class_getInstanceMethod(_NoInputAccessoryView.self, #selector(_NoInputAccessoryView.inputAccessoryView))

        class_addMethod(newClass!.self, #selector(_NoInputAccessoryView.inputAccessoryView), method_getImplementation(originalMethod!), method_getTypeEncoding(originalMethod!))

        object_setClass(targetView, newClass!)
    }
}

class _NoInputAccessoryView: NSObject {
    @objc func inputAccessoryView() -> AnyObject? {
        return WKWebView.inputAccessory
    }
}
