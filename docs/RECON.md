# Recon notes: pjett.trf5.jus.br PJe Consulta Publica

All statements below are VERIFIED with real HTTP requests unless marked ASSUMED.

## Stack

Verified from the HTML of `GET /pjeconsulta/ConsultaPublica/listView.seam`:

* PJe 2.11.2.0-26 (CNJ), JBoss Seam + JSF 1.2 + RichFaces 3.3.3.Final.
* This is NOT JSF 2. There is no `javax.faces.partial.ajax` protocol here.
  RichFaces 3.3 uses `A4J.AJAX.Submit(...)` and the wire format is an
  `AJAXREQUEST` form POST that answers with `ajax-response: true` and
  `content-type: text/xml`.
* `javax.faces.ViewState` is a server side token. On the list page it is
  `j_id1`, on the detail page it is `j_id2`. It stays stable across postbacks
  in the same view, so it is not a rolling nonce like a JSF 2 client side state.
* Cookies: `JSESSIONID` (path `/pjeconsulta`), `ROUTER_ID` (load balancer
  affinity) and two `trf50...` cookies. All must be carried.

## reCAPTCHA

The page loads `https://www.google.com/recaptcha/api.js`, but the trigger is
dead code. Verbatim from the served HTML:

    function executarReCaptcha() {
        if (false) {
            grecaptcha.execute();
            return false;
        }
        executarPesquisa();
    }

The server renders the guard as the literal `false`, so the search runs with no
token. VERIFIED: a search POST with no captcha field returned results.

## The search

Form id `fPP`, posted to `/pjeconsulta/ConsultaPublica/listView.seam`.
The submit is not the `fPP:searchProcessos` button. That button calls
`executarReCaptcha()`, which calls `executarPesquisa()`, which is an
`a4j:jsFunction` whose parameter is a generated id (`fPP:j_id244` in the
observed render). The generated id can change between deploys, so the scraper
reads it back out of the inline script at run time.

Fields observed on `fPP`:

* `fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso`
* `fPP:j_id162:processoReferenciaInput`
* `fPP:dnp:nomeParte`
* `fPP:j_id180:nomeAdv`
* `fPP:j_id189:classeJudicial` and `fPP:j_id189:sgbClasseJudicial_selection`
* `fPP:dpDec:documentoParte`
* `fPP:Decoration:numeroOAB`, `fPP:Decoration:estadoComboOAB`
* `fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate` (dd/MM/yyyy)
* `fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate` (dd/MM/yyyy)

Extra POST fields needed: `AJAXREQUEST=_viewRoot`, `fPP=fPP`,
`javax.faces.ViewState`, and the jsFunction parameter twice (name and value).

## The 30 result server cap

VERIFIED. A date range search answered with this banner inside the ajax XML:

    Sua consulta retornou muitos processos e somente os 30 primeiros
    serao exibidos. Por favor, refine sua pesquisa.

and the footer read `30 resultados encontrados`. The RichFaces datascroller div
in the results table footer was EMPTY. So the result grid itself never
paginates: the server truncates at 30 rows.

Evidence for the "the grid never paginates" claim. Every search below rendered
the datascroller div as EMPTY, so a single page held every row:

| criteria | rows rendered | footer label |
| --- | --- | --- |
| `nomeParte=ADEMILSON SOUZA` | 1 | 1 resultados encontrados |
| `nomeParte=ZILDA NASCIMENTO` | 2 | 2 resultados encontrados |
| `nomeParte=GERALDA PEREIRA` | 5 | 5 resultados encontrados |
| `classeJudicial=SUSPENSAO DE LIMINAR E DE SENTENCA` | 8 | 8 resultados encontrados |
| `nomeParte=FRANCISCA XAVIER` | 9 | 9 resultados encontrados |
| `nomeParte=ANTONIO XAVIER` | 18 | 18 resultados encontrados |
| `nomeParte=JOSE GUEDES` | 22 | 22 resultados encontrados |
| `dataAutuacao 01/08/2026..05/08/2026` | 30 | 30 resultados encontrados + cap banner |

22 rows on one page proves the page size is larger than 22, and the cap stops
the row count at 30, so a second page never appears.

## The form is STATEFUL. Always post every field.

VERIFIED the hard way. A POST that omitted the empty text inputs produced
results that belonged to the PREVIOUS search. JSF 1.2 only calls
`setSubmittedValue` for inputs present in the request, so any input left out of
the POST keeps the value the backing bean already held. The scraper therefore
always sends the complete field set, empty strings included.

With no criterion at all the server answers
`Pelo menos um dos criterios de pesquisa deve ser informado.`
With a one word party name it answers
`E necessario informar ao menos dois nomes para realizar a consulta por nome da parte.`

## Ajax response envelope (RichFaces 3.3)

The POST answers `200` with `content-type: text/xml` and these markers:

    <meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" />
    <span id="ajax-view-state">
      <input type="hidden" name="javax.faces.ViewState" value="j_id1" />
    </span>
    <meta id="Ajax-Response" name="Ajax-Response" content="true" />

The body is a fragment of real HTML, so cheerio parses it directly. The scraper
reads the new ViewState out of `#ajax-view-state` after every postback.

## Result row shape

    <td id="fPP:processosTable:127362:j_id255">
      <a onclick="openPopUp('Consulta publica',
        '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=fb64...')">
    <td id="fPP:processosTable:127362:j_id257">
      APELACAO CIVEL <a ...><b>ApCiv 0006388-48.1986.4.05.8401 - Desapropriacao</b></a>
      ESTADO DO RIO GRANDE DO NORTE X INSTITUTO NACIONAL DE COLONIZACAO E REFORMA AGRARIA
    <td id="fPP:processosTable:127362:j_id263">Juntada de Certidao (24/08/2026 14:46:39)</td>

`127362` is the internal process id. `ca` is an opaque token for the detail page.

## The detail page is a plain GET

`GET /pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<token>`

No postback and no ViewState needed. Panels observed:

* Dados do Processo: numero, data da distribuicao, classe judicial, assunto,
  jurisdicao, orgao julgador colegiado, orgao julgador, endereco, processo referencia
* Polo ativo, Polo Passivo, Outros interessados (name, document, role, representative)
* Movimentacoes do Processo (`j_id146:processoEvento`)
* Documentos juntados ao processo (`j_id146:processoDocumentoGridTab`)

The parties lists page with a datascroller. The movements panel and the documents
grid do NOT, and that difference caused the same defect twice: they have no
`<tfoot>` and no scroller, so they look complete. They page with a RichFaces
*Slider* labelled `pagina`:

    new Richfaces.Slider("j_id146:j_id561:j_id562",
      {'minValue':'1','maxValue':'5','sliderValue':'1',
       'onchange':'A4J.AJAX.Submit(\'j_id146:j_id561\',event,
           {\'containerId\':\'j_id146:j_id474\',
            \'parameters\':{\'j_id146:j_id561:j_id563\':\'...\'}})'})

**There are TWO sliders on a detail page**, and they are near identical: both are
labelled `pagina`, both drive an A4J postback, and only the `containerId` region
distinguishes them.

    j_id146:j_id561:*  region j_id146:j_id474  ->  Movimentacoes
    j_id146:j_id653:*  region j_id146:j_id569  ->  Documentos juntados

Measured on case `0001223-51.1994.4.05.8300`:

    delivered HTML only     15 movements, 15 documents
    movements slider only   65 movements, 15 documents
    both sliders            65 movements, 23 documents

The middle row is the dangerous one. It reconciles perfectly against the
movements footer and still loses eight downloadable PDFs, because the documents
grid keeps its own footer and its own slider. So the completeness check runs per
panel, against the footer of that panel.

The page request is an ordinary RichFaces 3.3 postback and needs BOTH the slider
value and the trigger parameter. With the value alone the server answers 200 and
re renders nothing. Verified live: page 1 alone yields 15 movements, all five
pages yield 65, which matches the footer exactly.

## PDF download

Each document row carries a real `href`:

    /pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam
      ?idBin=11651902
      &numeroDocumento=5abe939d72b1862284d4eb1566a3847dd743377d
      &nomeArqProcDocBin=Despacho
      &idProcessoDocumento=11863852
      &actionMethod=...processoDocumentoBinHome.setDownloadInstance%28row%29

VERIFIED behaviour: it answers `302` to
`/pjeconsulta/download.seam?cid=<conversationId>`, and that answers `200` with
`content-type: application/pdf` and `content-disposition: filename="Despacho"`.
VERIFIED that this works from a COMPLETELY FRESH cookie jar that never loaded
the detail page, so the link is self contained and the redirect only needs to be
followed.

## Character encoding trap

`listView.seam` answers `text/html;charset=ISO-8859-1` while the embedded
`<meta http-equiv>` claims UTF-8. The meta tag is wrong. The ajax postbacks
answer `text/xml;charset=UTF-8`. The scraper reads the charset from the HTTP
header and decodes with iconv-lite, so `Liquidacao` and friends survive.

## Classe judicial catalogue

The RichFaces suggestion box behind `fPP:j_id189:classeJudicial` answers with the
FULL catalogue whatever the typed prefix is. One POST with
`fPP:j_id189:sgbClasseJudicial` and `ajaxSingle` returned 132 entries of
`code = name`. Searching by classe needs only the NAME in
`fPP:j_id189:classeJudicial`; the `..._selection` hidden field can stay empty.

## Rate limiting

NOT OBSERVED. Across the whole recon session, run at roughly one request every
two seconds, the server never answered `429`. The backoff path in this scraper is
therefore exercised by a unit test against a local stub server, not by a live
`429`. See the Limitations section of the README.

## Documents that have no public PDF

A document row is one of two shapes.

A PDF row carries a real href with `idBin`, `numeroDocumento` and
`actionMethod=...setDownloadInstance(row)`. Those download, as described above.

An HTML row carries no href. It only opens a popup to
`DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam?ca=...&idProcessoDoc=N`.
VERIFIED that this route is login gated for an anonymous caller. Both attempts
answered `302` to `login.seam`:

* from a completely fresh cookie jar
* from a jar that had just loaded the parent detail page with a valid `ca`

The `Visualizar recibo` link on the same row,
`/pjeconsulta/Processo/reportCertidaoPDF.seam?idProcessoDoc=N`, is login gated in
the same way. So there is no public binary behind an HTML row. The scraper
records them with `formato: "html"` and does not count them as failures.

## The content-disposition header is lossy at the source

The PDF response names the file in `content-disposition`, but the server has
already destroyed the non ASCII characters before sending it. Raw bytes captured
from the wire for a document whose real name is
`Despacho Inspecao - 1774 - INSPECAO 2024 - 11a VARA FEDERAL/AL`:

    content-disposition: filename="Despacho Inspe??o - 1774 - INSPE??O 2024 - 11? VARA FEDERAL/AL"
    ...66696c656e616d653d22446573706163686f20496e737065fdfd6f202d2031373734...
                                                        ^^^^^^

Every accented character is a single `0xFD` byte. This is not a client side
decoding mistake: the byte on the wire is `0xFD`. The information is gone.

The scraper therefore builds the saved filename from the `nomeArqProcDocBin`
query parameter, which survives intact, and only logs the header value.

## Rows on one page, by search

Collected while establishing that the grid never paginates. Every one of these
rendered the datascroller div EMPTY.

| criteria | rows | footer |
| :--- | :--- | :--- |
| `nomeParte=ADEMILSON SOUZA` | 1 | 1 resultados encontrados |
| `nomeParte=ZILDA NASCIMENTO` | 2 | 2 resultados encontrados |
| `nomeParte=GERALDA PEREIRA` | 5 | 5 resultados encontrados |
| `classeJudicial=SUSPENSAO DE LIMINAR E DE SENTENCA` | 8 | 8 resultados encontrados |
| `nomeParte=FRANCISCA XAVIER` | 9 | 9 resultados encontrados |
| `nomeParte=ANTONIO XAVIER` | 18 | 18 resultados encontrados |
| `nomeParte=JOSE GUEDES` | 22 | 22 resultados encontrados |
| `nomeParte=MARIA GONCALVES` | 30 | cap banner |
| `dataAutuacao 19/08/2026..19/08/2026` | 30 | cap banner |
| `classeJudicial=APELACAO CIVEL` + `19/08/2026..19/08/2026` | 30 | cap banner |

The last row is the important one. Narrowing to one case class on one filing day
STILL hits the cap, which is why the scraper has to record saturated slices
rather than claim complete coverage.
