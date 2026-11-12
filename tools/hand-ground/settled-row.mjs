// Accept only a quiescent scene before and after measurement. Old raw rows remain intact.
export function settledRow(row){
 const s=row.loadStats;
 return !!row.settled&&(!s||(s.ready&&s.jobs===0&&s.wait?.handHere&&!s.wait.handBusy&&!s.wait.plantsBusy));
}
