//| scalaVersion: 3.7.2
//| repositories:
//| - https://jitpack.io
//| mvnDeps:
//| - com.lihaoyi:ammonite-repl-api_3.3.7:3.0.8
//| - sh.almond::jupyter-api:0.14.5
//| - com.lihaoyi::os-lib:0.11.3
//| - com.lihaoyi::upickle:4.0.2
//| scalacOptions:
//| - -Wconf:msg=A pure expression does nothing in statement position:s
object sample {
import _root_.ammonite.interp.api.InterpBridge.{value => interp}
import _root_.ammonite.repl.ReplBridge.{value => repl}
import _root_.ammonite.repl.ReplBridge.value.{codeColorsImplicit, tprintColorsImplicit, show}
import almond.display.{Data, Display, FileLink, Html, IFrame, Image, Javascript, Json, Latex, Markdown, Math, ProgressBar, Svg, Text, TextDisplay, UpdatableDisplay}
import almond.display.Display.{html, js, latex, markdown, svg, text}
import almond.interpreter.api.DisplayData.DisplayDataSyntax
import almond.input.Input
val kernel: almond.api.JupyterApi = ???
import kernel.{publish, commHandler}
import kernel.publish.display
/* --- cell 1 W1sZmlsZQ== */
/* [shadow] import $ivy.`com.lihaoyi::os-lib:0.11.3` */
/* [shadow] import $ivy.`com.lihaoyi::upickle:4.0.2` */

import scala.collection.mutable

def add(a: Int, b: Int): Int = a + b

val pwd = os.pwd
/* --- cell 3 W3sZmlsZQ== */
val total = add(1, 2) ; val res2_1 = (
s"total is $total")
/* --- cell 4 W4sZmlsZQ== */
/* [shadow] import $ivy.`com.lihaoyi::os-lib:0.11.3` */

val spec = ujson.read(os.read(pwd / "pie.vl.json")) ; val res3_2 = (
spec("mark").str)
/* --- cell 5 W5sZmlsZQ== */ val res4_0 = (
add(total, 40))
val res4 = res4_0
object `shadow scope 1` {
/* --- cell 6 W6sZmlsZQ== */ val res5_0 = (
// `total` is defined a second time, shadowing the one above
println("recomputing"))

val buf = mutable.ListBuffer(1, 2, 3)
val total = buf.sum
/* --- cell 7 W7sZmlsZQ== */ val res6_0 = (
Html(s"<b>total: $total</b>")) ; val res6_1 = (
publish.markdown("counted")) ; val res6_2 = (
Markdown("**done**"))
/* --- cell 8 W8sZmlsZQ== */
class Foo(val x: Int)
 val res7_1 = (
repl.pprinter() = {
  val p = repl.pprinter()
  p.copy(
    additionalHandlers = p.additionalHandlers.orElse {
      case f: Foo =>
        pprint.Tree.Lazy(_ => Iterator(fansi.Color.Yellow(s"foo: ${f.x}").render))
    }
  )
})

val f = Foo(1)
}
}
