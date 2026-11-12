// Local geometry-test harness. Serves only the selected app and this tool directory.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const APP=resolve(process.argv[2]||fileURLToPath(new URL('../../app',import.meta.url))),H=fileURLToPath(new URL('.',import.meta.url));
const types={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
createServer(async(req,res)=>{
 try{
  const url=decodeURIComponent(new URL(req.url,'http://localhost').pathname),harness=url.startsWith('/__h/'),root=harness?H:APP;
  const file=resolve(join(root,harness?url.slice(5):url==='/'?'index.html':url)),rel=relative(root,file);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')){res.writeHead(403);res.end();return;}
  const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
 }catch{res.writeHead(404);res.end();}
}).listen(+(process.argv[3]||0),'127.0.0.1',function(){console.log('PORT '+this.address().port);});
